import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { getWork, listWorkEvents } from "../../db/repositories/workLedger.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { WORK_STATUSES, type WorkTransitionAudit } from "./contracts.ts";
import {
  applyIssueWorkAction,
  getIssueAsWork,
  issueAsWork,
  issueIDToWorkID,
  issueStatusToWorkStatus,
  listIssueBackedWorks,
  syncIssueWorkShadow,
  updateIssueBackedWork,
  workIDToIssueID,
  workStatusToIssueStatus
} from "./issueAdapter.ts";

const tempRoots: string[] = [];
const PROJECT_ID = "demo";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue-backed Work compatibility adapter", () => {
  test("round-trips canonical Issue and Work ids and rejects other authorities", () => {
    expect(issueIDToWorkID(650)).toBe("xw:work:issues:650");
    expect(workIDToIssueID(issueIDToWorkID(650))).toBe(650);
    expect(() => workIDToIssueID("xw:work:issues:0650")).toThrow("canonical Issue-backed Work id");
    expect(() => workIDToIssueID(makeDomainID("work", "issues", "not-a-number"))).toThrow("canonical Issue-backed Work id");
    expect(() => workIDToIssueID(makeDomainID("run", "issue_runs", "issue-650-attempt-1"))).toThrow(
      "canonical Issue-backed Work id"
    );
  });

  test("projects every existing Issue status and rich fixture fields without persisting a second authority", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      for (const [index, status] of WORK_STATUSES.entries()) {
        createIssue(db, {
          agent_profile_id: "profile-main",
          description: `Deliver fixture ${status}`,
          priority: index,
          project_id: PROJECT_ID,
          recommended_mcp_capabilities: ["browser:tool:inspect"],
          recommended_skill_intents: ["review"],
          required_mcp_capabilities: ["docs:resource:runbook"],
          required_skill_intents: ["test"],
          service_tier: "priority",
          source_excerpt: "source excerpt",
          source_session_id: "codex:thread-1",
          source_turn_id: "turn-1",
          status,
          title: `Fixture ${status}`,
          workflow_snapshot_json: JSON.stringify({ workflow: status })
        });
      }

      const works = listIssueBackedWorks(db, { projectId: PROJECT_ID });

      expect(new Set(works.map((work) => work.status))).toEqual(new Set(WORK_STATUSES));
      for (const work of works) {
        expect(work).toMatchObject({
          acceptance: {
            completion_rule: "all_required",
            criteria: [{ id: "issue-delivery", required: true, verification_policy_ref: "agent-execution-contract" }],
            requires_handoff: true,
            version: 1
          },
          owner: { kind: "project", project_id: PROJECT_ID },
          provenance: {
            causes: [],
            origin: {
              authority: "issues",
              completeness: "legacy_incomplete",
              kind: "issue",
              missing_fields: ["actor", "correlation_id"],
              source_event_id: expect.stringContaining("xw:evidence:issue_events:")
            }
          },
          type: "engineering_task"
        });
        expect(work.goal).toBe(`Deliver fixture ${work.status}`);
        expect(work.workflow_ref).toMatch(/^issues:\d+:workflow:[a-f0-9]{16}$/);
        expect(workIDToIssueID(work.id)).toBeGreaterThan(0);
        expect(getWork(db, work.id)).toBeNull();
      }
      for (const status of WORK_STATUSES) {
        expect(workStatusToIssueStatus(issueStatusToWorkStatus(status))).toBe(status);
      }
    } finally {
      db.close();
    }
  });

  test("uses complete issue.created provenance when deterministic actor evidence exists", () => {
    const issue = issueFixture(12, "todo");
    const work = issueAsWork(issue, {
      created_at: issue.created_at,
      id: 99,
      issue_id: issue.id,
      payload: JSON.stringify({
        actor: { id: "user-1", kind: "user" },
        correlation_id: "request-12"
      }),
      type: "issue.created"
    });

    expect(work.provenance.origin).toEqual({
      actor: { id: "user-1", kind: "user" },
      authority: "issues",
      completeness: "complete",
      correlation_id: "request-12",
      external_id: "12",
      kind: "issue",
      occurred_at: issue.created_at,
      source_event_id: makeDomainID("evidence", "issue_events", 99)
    });
  });

  test("round-trips compatible title and goal writes with optimistic conflict and idempotent audit", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const issue = createIssue(db, { description: "Before", project_id: PROJECT_ID, status: "triage", title: "Before" });
      const before = mustGetIssueWork(db, issue.id);
      const command = {
        audit: audit("update-1"),
        expected_revision: before.revision,
        patch: { goal: "After goal", title: "After title" },
        work_id: before.id
      };

      const updated = updateIssueBackedWork(db, command);
      const replay = updateIssueBackedWork(db, command);
      const stale = updateIssueBackedWork(db, {
        ...command,
        audit: audit("update-stale"),
        patch: { title: "Must not win" }
      });

      expect(updated).toMatchObject({ applied: true, shadow: { mode: "disabled", status: "disabled" } });
      expect(updated.work).toMatchObject({ goal: "After goal", title: "After title" });
      expect(replay).toMatchObject({ applied: true, work: { title: "After title" } });
      expect(stale).toMatchObject({ applied: false, work: { title: "After title" } });
      expect(stale.violations[0]).toContain("expected revision");
      expect(getIssue(db, issue.id)).toMatchObject({ description: "After goal", title: "After title" });
      expect(adapterAudits(db, issue.id)).toMatchObject([
        { event_id: "update-1", operation: "update", outcome: "applied" },
        { event_id: "update-stale", operation: "update", outcome: "rejected" }
      ]);
    } finally {
      db.close();
    }
  });

  test("routes Work actions through existing Issue actions and rejects an untrusted transition", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const issue = createIssue(db, { project_id: PROJECT_ID, status: "triage", title: "Action fixture" });
      const before = mustGetIssueWork(db, issue.id);

      const enqueued = applyIssueWorkAction(db, {
        action: "enqueue",
        audit: audit("enqueue-1"),
        expected_revision: before.revision,
        work_id: before.id
      });
      const denied = applyIssueWorkAction(db, {
        action: "cancel",
        audit: audit("cancel-denied", "ask"),
        expected_revision: enqueued.work.revision,
        work_id: before.id
      });
      const cancelled = applyIssueWorkAction(db, {
        action: "cancel",
        audit: audit("cancel-1"),
        expected_revision: enqueued.work.revision,
        work_id: before.id
      });

      expect(enqueued).toMatchObject({ applied: true, work: { status: "todo" } });
      expect(denied).toMatchObject({ applied: false, work: { status: "todo" } });
      expect(denied.violations).toContain("transition gate requires approval");
      expect(cancelled).toMatchObject({ applied: true, work: { status: "cancelled" } });
      expect(getIssue(db, issue.id)?.status).toBe("cancelled");
      expect(issueStatusEvents(db, issue.id).map((payload) => payload.status)).toEqual(["todo", "cancelled"]);
    } finally {
      db.close();
    }
  });

  test("treats enqueue on an already queued Work as an audited idempotent kick", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const issue = createIssue(db, { project_id: PROJECT_ID, status: "todo", title: "Queued without Run" });
      const work = mustGetIssueWork(db, issue.id);

      const kicked = applyIssueWorkAction(db, {
        action: "enqueue",
        audit: audit("enqueue-todo-idempotent"),
        expected_revision: work.revision,
        work_id: work.id
      });

      expect(kicked).toMatchObject({ applied: true, violations: [], work: { status: "todo" } });
      expect(getIssue(db, issue.id)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(issueStatusEvents(db, issue.id)).toEqual([]);
      expect(adapterAudits(db, issue.id)).toContainEqual(expect.objectContaining({
        event_id: "enqueue-todo-idempotent",
        operation: "enqueue",
        outcome: "applied",
        requested: { idempotent: true, to: "todo" }
      }));
    } finally {
      db.close();
    }
  });

  test("keeps the old Issue API behavior and data path unchanged", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const issue = createIssue(db, { project_id: PROJECT_ID, status: "triage", title: "Legacy API" });

      const legacy = updateIssue(db, issue.id, { description: "Legacy write", status: "done", title: "Legacy done" });

      expect(legacy).toMatchObject({ description: "Legacy write", status: "done", title: "Legacy done" });
      expect(mustGetIssueWork(db, issue.id)).toMatchObject({ goal: "Legacy write", status: "done", title: "Legacy done" });
      expect(adapterAudits(db, issue.id)).toEqual([]);
      expect(getWork(db, issueIDToWorkID(issue.id))).toBeNull();
    } finally {
      db.close();
    }
  });

  test("isolates a rejected shadow transition while legacy remains authoritative", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, PROJECT_ID);
      const issue = createIssue(db, {
        description: "Verify first",
        project_id: PROJECT_ID,
        status: "pending_verification",
        title: "Shadow fixture"
      });
      const initial = mustGetIssueWork(db, issue.id);
      expect(syncIssueWorkShadow(db, issue.id, audit("shadow-seed"))).toMatchObject({ status: "created" });
      expect(getWork(db, initial.id)?.status).toBe("pending_verification");

      updateIssue(db, issue.id, { status: "done" });
      const legacyDone = mustGetIssueWork(db, issue.id);
      const result = updateIssueBackedWork(db, {
        audit: audit("shadow-conflict"),
        expected_revision: legacyDone.revision,
        patch: { title: "Legacy still wins" },
        shadow_mode: "best_effort",
        work_id: legacyDone.id
      });

      expect(result).toMatchObject({
        applied: true,
        shadow: { mismatches: ["status"], mode: "best_effort", status: "mismatch" },
        work: { status: "done", title: "Legacy still wins" }
      });
      expect(getIssue(db, issue.id)).toMatchObject({ status: "done", title: "Legacy still wins" });
      expect(getWork(db, initial.id)).toMatchObject({ status: "pending_verification", title: "Legacy still wins" });
      expect(listWorkEvents(db, initial.id)).toContainEqual(expect.objectContaining({ outcome: "rejected" }));
      expect(shadowMismatches(db, issue.id)).toMatchObject([{ event_id: "shadow-conflict", mismatches: ["status"] }]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-issue-work-adapter-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  const timestamp = "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 1, ?, ?)`,
    [id, id, `/tmp/${id}`, timestamp, timestamp]
  );
}

function audit(eventID: string, decision: "allow" | "ask" | "deny" = "allow"): WorkTransitionAudit {
  return {
    actor: { id: "runner-test", kind: "runner" },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    gate: { authority: "deterministic_policy", decision, policy_ref: "issue-work-adapter-test" },
    occurred_at: "2026-01-02T00:00:00Z",
    reason: `test ${eventID}`
  };
}

function mustGetIssueWork(db: RunnerDatabase, issueID: number) {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`missing Issue-backed Work ${issueID}`);
  return work;
}

function adapterAudits(db: RunnerDatabase, issueID: number): Array<Record<string, unknown>> {
  return eventPayloads(db, issueID, "issue.work_adapter_write");
}

function shadowMismatches(db: RunnerDatabase, issueID: number): Array<Record<string, unknown>> {
  return eventPayloads(db, issueID, "issue.work_shadow_mismatch");
}

function issueStatusEvents(db: RunnerDatabase, issueID: number): Array<Record<string, unknown>> {
  return eventPayloads(db, issueID, "issue.status_changed");
}

function eventPayloads(db: RunnerDatabase, issueID: number, type: string): Array<Record<string, unknown>> {
  return db.sqlite.query<{ payload: string }, [number, string]>(
    "select payload from issue_events where issue_id=? and type=? order by id"
  ).all(issueID, type).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

function issueFixture(id: number, status: string) {
  const timestamp = "2026-01-01T00:00:00Z";
  return {
    agent_profile_id: "",
    attempt_count: 0,
    auto_retry_next_at: "",
    auto_retry_reason: "",
    codex_thread_id: "",
    codex_turn_id: "",
    comment_count: 0,
    created_at: timestamp,
    description: "Fixture goal",
    error: "",
    id,
    issue_log_mode: "normal" as const,
    priority: 0,
    project_id: PROJECT_ID,
    recommended_mcp_capabilities: "[]",
    recommended_skill_intents: "[]",
    required_mcp_capabilities: "[]",
    required_skill_intents: "[]",
    service_tier: "",
    source_excerpt: "",
    source_session_id: "",
    source_turn_id: "",
    status,
    title: "Fixture",
    updated_at: timestamp,
    workflow_snapshot_json: ""
  };
}
