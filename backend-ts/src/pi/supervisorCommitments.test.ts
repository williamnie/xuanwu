import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import {
  createPiConversation,
  getPiIssueCompletionWatch,
  listPiActionEvents,
  listPiMemoryItems,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import { buildPiMemoryPromptContext } from "./memoryContext.ts";
import {
  createIssueCompletionWatchAction,
  cancelIssueCompletionWatchAction
} from "./issueCompletionWatchActions.ts";
import { evaluatePiIssueCompletionWatchesForIssue } from "./issueCompletionWatchEvaluator.ts";
import {
  SUPERVISOR_COMMITMENT_RETENTION,
  buildSupervisorCommitmentPromptContext,
  cancelSupervisorCommitment,
  createSupervisorCommitment,
  linkSupervisorCommitmentsForConversation,
  listSupervisorCommitments,
  sweepExpiredSupervisorCommitments
} from "./supervisorCommitments.ts";

const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0053-supervisor-goal-commitment.md");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Supervisor Goal, Commitment and conversation continuity", () => {
  test("restores unfinished Work after restart and resumes it in another conversation", async () => {
    const fixture = await openFixture("commitment-restart-");
    const uniqueGoal = "Restart continuity goal from authoritative Work";
    const issue = createIssue(fixture.db, {
      description: uniqueGoal,
      project_id: "demo",
      status: "in_progress",
      title: "Continue after restart"
    });
    const created = createSupervisorCommitment(fixture.db, commitmentInput(issue.id, "conv-a", {
      due_at: "2099-07-18T09:00:00+08:00"
    }));
    const watchID = created.watch.id;

    fixture.db.close();
    fixture.db = await openDatabase({ stateDir: fixture.stateDir });

    const restored = listSupervisorCommitments(fixture.db, {
      conversationID: "conv-a",
      statuses: ["active"]
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      due_at: "2099-07-18T01:00:00.000Z",
      goal: {
        statements: [uniqueGoal],
        work_ids: [`xw:work:issues:${issue.id}`]
      },
      retention: SUPERVISOR_COMMITMENT_RETENTION,
      status: "active",
      watch_id: watchID
    });

    const resumed = linkSupervisorCommitmentsForConversation(fixture.db, {
      conversationID: "conv-b",
      projectID: "demo",
      workIDs: [`xw:work:issues:${issue.id}`]
    })[0]!;
    const prompt = buildSupervisorCommitmentPromptContext(fixture.db, {
      conversationID: "conv-b",
      now: new Date("2026-07-17T10:00:00.000Z")
    });

    expect(resumed.conversation.linked_ids).toEqual(["conv-a", "conv-b"]);
    expect(prompt).toContain(uniqueGoal);
    expect(prompt).toContain(`xw:work:issues:${issue.id}`);
    expect(listPiActionEvents(fixture.db, {
      actionId: `supervisor-commitment:${watchID}`,
      eventType: "supervisor_commitment_resumed"
    })).toMatchObject([{
      actor: "deterministic_supervisor_context",
      conversation_id: "conv-b",
      decision: "active"
    }]);

    expect(listPiMemoryItems(fixture.db)).toEqual([]);
    expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" })).not.toContain(uniqueGoal);
  });

  test("keeps pending verification active and queues the existing completion notification only after done", async () => {
    const fixture = await openFixture("commitment-completion-");
    const issue = createIssue(fixture.db, {
      description: "Verified completion goal",
      project_id: "demo",
      status: "todo",
      title: "Verify before completion"
    });
    const action = createIssueCompletionWatchAction(fixture.db, commitmentActionInput(issue.id, "conv-a"));
    const watchID = action.watch_id as string;
    const watch = getPiIssueCompletionWatch(fixture.db, watchID);

    expect(JSON.parse(watch?.condition ?? "{}")).toMatchObject({
      commitment: {
        retention: SUPERVISOR_COMMITMENT_RETENTION,
        schema_version: "xw.supervisor-commitment.v1"
      },
      pending_verification_satisfies: false,
      terminal_statuses: ["done", "failed", "cancelled"]
    });

    updateIssue(fixture.db, issue.id, { status: "pending_verification" });
    const pending = evaluatePiIssueCompletionWatchesForIssue(fixture.db, {
      eventID: "commitment-pending-verification",
      issueID: issue.id,
      status: "pending_verification"
    });
    expect(pending.satisfied).toBe(0);
    expect(getPiIssueCompletionWatch(fixture.db, watchID)?.status).toBe("active");
    expect(listPiNotificationIntents(fixture.db, { kind: "issue_completion_watch_satisfied" })).toEqual([]);

    updateIssue(fixture.db, issue.id, { status: "done" });
    const completed = evaluatePiIssueCompletionWatchesForIssue(fixture.db, {
      eventID: "commitment-done",
      eventType: "issue.status_changed",
      issueID: issue.id,
      status: "done"
    });
    const projection = listSupervisorCommitments(fixture.db, { projectID: "demo" })[0];

    expect(completed).toMatchObject({ intents: 1, satisfied: 1 });
    expect(projection).toMatchObject({
      completion_notification: { state: "pending" },
      status: "completed",
      watch_id: watchID
    });
    expect(listPiNotificationIntents(fixture.db, { kind: "issue_completion_watch_satisfied" }))
      .toMatchObject([{ conversation_id: "conv-a", project_id: "demo", state: "ready" }]);
    expect(listPiActionEvents(fixture.db, {
      actionId: `supervisor-commitment:${watchID}`,
      eventType: "supervisor_commitment_completed"
    })).toHaveLength(1);
    expect(listNotifications(fixture.db, { projectID: "demo" })).toMatchObject([{
      event: "supervisor.commitment.completed",
      issue_id: issue.id,
      project_id: "demo"
    }]);
  });

  test("audits cancel, forget and deterministic due expiry without deleting Work", async () => {
    const fixture = await openFixture("commitment-lifecycle-");
    const cancelIssue = createIssue(fixture.db, { project_id: "demo", status: "todo", title: "Cancel goal" });
    const forgetIssue = createIssue(fixture.db, { project_id: "demo", status: "todo", title: "Forget goal" });
    const expireIssue = createIssue(fixture.db, { project_id: "demo", status: "todo", title: "Expire goal" });
    const cancelled = createSupervisorCommitment(fixture.db, commitmentInput(cancelIssue.id, "conv-a"));
    const forgotten = createSupervisorCommitment(fixture.db, commitmentInput(forgetIssue.id, "conv-a"));
    const expiring = createSupervisorCommitment(fixture.db, commitmentInput(expireIssue.id, "conv-a", {
      due_at: "2026-07-18T00:00:00.000Z"
    }), new Date("2026-07-17T00:00:00.000Z"));

    cancelSupervisorCommitment(fixture.db, cancelled.watch.id, {
      actor: "user-1",
      conversationID: "conv-a",
      reason: "No longer needed"
    });
    cancelIssueCompletionWatchAction(fixture.db, {
      reason: "supervisor_commitment_forget",
      watch_id: forgotten.watch.id
    });
    expect(sweepExpiredSupervisorCommitments(fixture.db, new Date("2026-07-19T00:00:00.000Z")))
      .toEqual({ expired: 1, scanned: 1 });

    const statuses = Object.fromEntries(listSupervisorCommitments(fixture.db, { projectID: "demo" })
      .map((commitment) => [commitment.watch_id, commitment.status]));
    expect(statuses).toEqual({
      [cancelled.watch.id]: "cancelled",
      [expiring.watch.id]: "expired",
      [forgotten.watch.id]: "forgotten"
    });
    expect(buildSupervisorCommitmentPromptContext(fixture.db, {
      projectID: "demo",
      now: new Date("2026-07-19T00:00:00.000Z")
    })).toContain("No active commitments");
    expect(fixture.db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(3);

    const eventTypes = listPiActionEvents(fixture.db, { projectId: "demo" }).map((event) => event.event_type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "supervisor_commitment_cancelled",
      "supervisor_commitment_expired",
      "supervisor_commitment_forgotten"
    ]));
  });

  test("locks authority, compatibility, rollback and deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "issues-via-work-adapter",
      "pi_issue_completion_watches",
      "pi_action_events",
      "双写：0",
      "双读：0",
      "operational_not_memory",
      "回滚",
      "最终删除门禁"
    ]) expect(adr).toContain(phrase);
  });
});

async function openFixture(prefix: string): Promise<{
  db: RunnerDatabase;
  root: string;
  stateDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  const db = await openDatabase({ stateDir });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-07-17T00:00:00Z", "2026-07-17T00:00:00Z"]
  );
  for (const id of ["conv-a", "conv-b"]) {
    createPiConversation(db, { id, pi_agent_id: "fixture-agent", project_id: "demo", title: id });
  }
  return { db, root, stateDir };
}

function commitmentInput(issueID: number, conversationID: string, commitment: Record<string, unknown> = {}) {
  return {
    condition: {
      commitment: {
        schema_version: "xw.supervisor-commitment.v1",
        ...commitment
      }
    },
    issue_ids: [issueID],
    origin_conversation_id: conversationID,
    project_id: "demo",
    requested_by: "user-1",
    source_event_id: `source-${issueID}`
  };
}

function commitmentActionInput(issueID: number, conversationID: string) {
  return {
    ...commitmentInput(issueID, conversationID),
    note: "Notify when authoritative Work is done"
  };
}
