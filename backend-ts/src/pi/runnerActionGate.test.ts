import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getPiAction, getPiIssueCompletionWatch, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";

describe("PI runner action gate", () => {
  test("delegated mode only auto-executes actions covered by an authorization envelope", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Delegated" });
      const denied = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID + 1, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "not covered" }) as { action_id: string; decision: string; status: string };
      const allowed = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "covered" }) as { action_id: string; decision: string; status: string };
      const allowedAction = listPiActions(fixture.db).find((action) => action.gate_decision === "execute");

      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(allowed).toMatchObject({ type: "issue.comment", issue_id: issueID });
      expect(allowedAction).toMatchObject({
        action_type: "issue.comment",
        gate_decision: "execute",
        status: "completed"
      });
      expect(listIssueEvents(fixture.db, issueID).map((event) => event.payload)).toEqual([
        expect.stringContaining("covered")
      ]);
      expect(listPiActionEvents(fixture.db, { actionId: denied.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("delegated authorization auto-executes covered confirm action proposals", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Ready" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      });
      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "delegated ready" }) as {
        action_id: string; decision: string; status: string;
      };
      const stored = getPiAction(fixture.db, result.action_id);

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(stored).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(listPiActionEvents(fixture.db, { actionId: result.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("notifies runtime when delegated enqueue should start an executor session", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Run from Feishu" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        project: fixture.project
      });

      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "default run from Feishu" }) as {
        action_id: string; decision: string; status: string;
      };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(kicked).toEqual([fixture.project.id]);
    } finally {
      await fixture.close();
    }
  });

  test("Runner Chat source scopes enqueue from explicit issue id without a conversation project", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Start by id" });
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        source: "feishu_runner_chat"
      });

      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "开始明确 issue" }) as {
        action_id: string; decision: string; status: string;
      };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        project_id: fixture.project.id,
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(kicked).toEqual([fixture.project.id]);
    } finally {
      await fixture.close();
    }
  });

  test("Runner Chat directly cancels an explicit batch of triage issues", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueIDs = ["A", "B", "C"].map((title) => insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: `Cancel ${title}`
      }));
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        source: "feishu_runner_chat"
      });

      const result = await actions.cancelIssues({ issue_ids: issueIDs, rationale: "用户明确说不做了" }) as {
        action_id: string; decision: string; result: { accepted: number; requested_status: string }; status: string;
      };

      expect(result).toMatchObject({
        decision: "execute",
        result: { accepted: 3, requested_status: "cancelled", status: "completed" },
        status: "completed"
      });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.cancel",
        gate_decision: "execute",
        project_id: fixture.project.id,
        status: "completed"
      });
      expect(issueIDs.map((id) => getIssue(fixture.db, id)?.status)).toEqual([
        "cancelled", "cancelled", "cancelled"
      ]);
      expect(kicked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("delegated PI can move explicit issues through the shared status contract", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const first = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Move first"
      });
      const second = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Move second"
      });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowedActions: ["issue.status_update"],
          authorizedActions: [{ action_type: "issue.status_update", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        project: fixture.project
      });

      const moved = await actions.updateIssueStatuses({
        issue_ids: [first, second],
        reason: "用户要求放入待办",
        status: "todo"
      }) as { action_id: string; result: { accepted: number; items: Array<Record<string, unknown>> }; status: string };
      const detail = actions.readIssue({ id: first }) as {
        allowed_status_targets: string[];
        dependency: { ready: boolean; reason: string };
        execution: { issue: { id: number; status: string } };
        status: string;
      };

      expect(moved).toMatchObject({
        result: {
          accepted: 2,
          items: [
            { actual_status: "todo", reached_target: true, requested_status: "todo" },
            { actual_status: "todo", reached_target: true, requested_status: "todo" }
          ],
          requested_status: "todo",
          status: "completed"
        },
        status: "completed"
      });
      expect(getPiAction(fixture.db, moved.action_id)).toMatchObject({
        action_type: "issue.status_update",
        gate_decision: "execute",
        status: "completed"
      });
      expect(detail).toMatchObject({
        allowed_status_targets: ["triage", "in_progress", "cancelled"],
        dependency: { ready: true, reason: "ready" },
        execution: { issue: { id: first, status: "todo" } },
        status: "todo"
      });
      expect(kicked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("PI rejects invalid terminal status moves before mutating any issue", async () => {
    const fixture = await openFixture();
    try {
      const done = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "done",
        title: "Already done"
      });
      const triage = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Must remain triage"
      });
      const actions = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      });

      expect(() => actions.updateIssueStatuses({
        issue_ids: [done, triage],
        reason: "错误的批量移动",
        status: "todo"
      })).toThrow(/Issue #.*不允许从 done 移动到 todo/);
      expect(getIssue(fixture.db, done)?.status).toBe("done");
      expect(getIssue(fixture.db, triage)?.status).toBe("triage");
    } finally {
      await fixture.close();
    }
  });

  test("completion watch create/cancel follow delegated, attended, and read-only gate semantics", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Watch me" });
      const attended = createPiRunnerActions(fixture.db, { project: fixture.project })
        .createIssueCompletionWatch({ issue_ids: [issueID], target_channel: "feishu" }) as {
          action_id: string; decision: string; status: string;
        };

      expect(attended).toMatchObject({ decision: "ask", status: "pending" });
      expect(listPiActions(fixture.db, { status: "pending" })).toContainEqual(expect.objectContaining({
        action_type: "issue_completion_watch.create",
        risk_level: "medium"
      }));

      const delegated = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      }).createIssueCompletionWatch({
        issue_ids: [issueID],
        source_event_id: "event-1",
        target_channel: "feishu",
        target_chat_id: "oc_group"
      }) as {
        result?: { watch_id?: string };
        status: string;
      };
      const watchID = delegated.result?.watch_id ?? "";

      expect(delegated).toMatchObject({
        decision: "execute",
        result: {
          already_satisfied: false,
          target_channel: "feishu",
          watched_issues: [{ id: issueID, title: "Watch me" }]
        },
        status: "completed"
      });
      expect(getPiIssueCompletionWatch(fixture.db, watchID)).toMatchObject({
        status: "active",
        target_chat_id: "oc_group",
        items: [expect.objectContaining({ issue_id: issueID })]
      });

      const readOnly = createPiRunnerActions(fixture.db, {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).listIssueCompletionWatches({ project_id: fixture.project.id }) as { status?: string; items?: unknown[] };

      expect(readOnly).toMatchObject({ count: 1, items: [expect.objectContaining({ watch_id: watchID })] });
      expect(readOnly.status).toBeUndefined();

      const cancelled = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      }).cancelIssueCompletionWatch({ reason: "user_cancel", watch_id: watchID }) as {
        result?: { current_status?: string; watch_id?: string };
        status: string;
      };

      expect(cancelled).toMatchObject({
        decision: "execute",
        result: { current_status: "cancelled", watch_id: watchID },
        status: "completed"
      });
      expect(getPiIssueCompletionWatch(fixture.db, watchID)).toMatchObject({
        error: "user_cancel",
        status: "cancelled"
      });
      expect(() => createPiRunnerActions(fixture.db, { project: fixture.project })
        .createIssueCompletionWatch({ issue_ids: [], project_id: fixture.project.id }))
        .toThrow("issue_ids is required");
    } finally {
      await fixture.close();
    }
  });

  test("delegated authorization does not auto-execute covered high-risk proposals", async () => {
    const fixture = await openFixture();
    try {
      insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-1" });
      const result = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "session.steer", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).createSessionSteerProposal({
        prompt: "change running executor",
        session_key: "codex:thread-1"
      }) as { action_id: string; decision: string; status: string };
      const stored = getPiAction(fixture.db, result.action_id);

      expect(result).toMatchObject({ decision: "ask", status: "pending" });
      expect(stored).toMatchObject({
        action_type: "session.steer",
        gate_decision: "ask",
        risk_level: "high",
        status: "pending"
      });
      expect(listPiActionEvents(fixture.db, { actionId: result.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-action-gate-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function insertIssue(db: RunnerDatabase, input: { projectID: string; status: string; title: string }): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [input.projectID, input.title, input.status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertAgentSession(db: RunnerDatabase, input: { projectID: string; sessionKey: string }): void {
  const [, sessionID] = input.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.sessionKey, "codex", sessionID, input.projectID, "Thread 1", "running",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
