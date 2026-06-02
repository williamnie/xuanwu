import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getPiAction, listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { diagnoseIssueState } from "./issueStateManager.ts";

const tempRoots: string[] = [];

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-state-manager-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, "demo");
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue State Manager diagnosis", () => {
  test("diagnoses issue/session/runtime inconsistencies with explainable recommended actions", async () => {
    const fixture = await openFixture();
    try {
      const todo = insertIssue(fixture.db, { status: "todo", title: "Todo without session", updatedAt: "2026-01-01T00:00:00Z" });
      const ended = insertIssue(fixture.db, {
        codexThreadID: "thread-ended",
        status: "in_progress",
        title: "Ended session",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      insertRun(fixture.db, ended, { endedAt: "2026-01-01T00:20:00Z", sessionID: "thread-ended", status: "done" });
      insertSession(fixture.db, ended, { sessionID: "thread-ended", status: "completed", updatedAt: "2026-01-01T00:21:00Z" });
      const retry = insertIssue(fixture.db, {
        attemptCount: 1,
        error: "stream disconnected before completion",
        status: "failed",
        title: "Retryable failure",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      const pending = insertIssue(fixture.db, {
        error: "tests passed; waiting for acceptance",
        status: "pending_verification",
        title: "Pending too long",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      const done = insertIssue(fixture.db, { status: "done", title: "Done without proof", updatedAt: "2026-01-01T00:00:00Z" });

      const result = diagnoseIssueState(fixture.db, {
        maxRetries: 3,
        now: new Date("2026-01-02T03:00:00Z"),
        pendingVerificationTimeoutMs: 24 * 60 * 60 * 1000,
        projectID: fixture.project.id,
        retryCooldownMs: 30 * 60 * 1000
      });
      const byIssue = new Map(result.diagnostics.map((item) => [item.issue_id, item]));

      expect(byIssue.get(todo)).toMatchObject({
        code: "todo_without_session",
        recommended_actions: [expect.objectContaining({ action_type: "issue.state_repair", operation: "enqueue" })]
      });
      expect(byIssue.get(ended)).toMatchObject({
        code: "in_progress_session_ended",
        recommended_actions: [expect.objectContaining({ operation: "patch_status", patch: { status: "pending_verification" } })]
      });
      expect(byIssue.get(ended)?.evidence.map((item) => item.source).sort()).toEqual(["issue", "run", "session"]);
      expect(byIssue.get(retry)).toMatchObject({
        code: "failed_retry_ready",
        recommended_actions: [expect.objectContaining({ operation: "retry" })]
      });
      expect(byIssue.get(pending)).toMatchObject({
        code: "pending_verification_timeout",
        severity: "needs_user",
        recommended_actions: [expect.objectContaining({ operation: "comment" })]
      });
      expect(byIssue.get(done)).toMatchObject({
        code: "done_missing_verification_evidence",
        recommended_actions: [expect.objectContaining({ operation: "patch_status", patch: { status: "pending_verification" } })]
      });
      expect(JSON.stringify(result.diagnostics)).toContain("thread-ended");
    } finally {
      await fixture.close();
    }
  });

  test("honors retry cooldown, max retry, needs-user escalation, and batch targets", async () => {
    const fixture = await openFixture();
    try {
      const cooling = insertIssue(fixture.db, {
        attemptCount: 1,
        autoRetryNextAt: "2026-01-01T02:00:00Z",
        autoRetryReason: "network error",
        error: "network error",
        status: "failed",
        title: "Cooling retry",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      const maxed = insertIssue(fixture.db, {
        attemptCount: 3,
        error: "transport error",
        status: "failed",
        title: "Maxed retry",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      const user = insertIssue(fixture.db, {
        attemptCount: 1,
        error: "approval denied; waiting for user input",
        status: "failed",
        title: "Needs user",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      const done = insertIssue(fixture.db, { status: "done", title: "Completed target", updatedAt: "2026-01-01T00:00:00Z" });
      insertEvent(fixture.db, done, "issue.verification_reviewed", { action: "accept", status: "done" });

      const result = diagnoseIssueState(fixture.db, {
        batchTarget: {
          deadline_at: "2026-01-01T23:59:59Z",
          issue_ids: [cooling, maxed, user, done],
          label: "tonight",
          status: "done"
        },
        maxRetries: 3,
        now: new Date("2026-01-01T01:00:00Z"),
        projectID: fixture.project.id,
        retryCooldownMs: 30 * 60 * 1000
      });
      const byIssue = new Map(result.diagnostics.map((item) => [item.issue_id, item]));

      expect(byIssue.get(cooling)).toMatchObject({ code: "failed_retry_cooling_down", recommended_actions: [] });
      expect(byIssue.get(maxed)).toMatchObject({ code: "failed_retry_exhausted", severity: "needs_user" });
      expect(byIssue.get(user)).toMatchObject({ code: "needs_user_escalation", severity: "needs_user" });
      expect(byIssue.has(done)).toBe(false);
      expect(result.batch_targets).toEqual([expect.objectContaining({
        deadline_at: "2026-01-01T23:59:59Z",
        done: 1,
        label: "tonight",
        off_track_issue_ids: [cooling, maxed, user],
        target: 4,
        target_status: "done"
      })]);
    } finally {
      await fixture.close();
    }
  });
});

describe("Issue State Manager PI actions", () => {
  test("attended mode creates a repair proposal without mutating state", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { status: "done", title: "Weak done", updatedAt: "2026-01-01T00:00:00Z" });
      const result = createPiRunnerActions(fixture.db, { project: fixture.project }).createIssueStateRepairProposal({
        diagnosis_code: "done_missing_verification_evidence",
        issue_id: issueID,
        rationale: "needs proof"
      }) as { action_id: string; status: string };

      expect(result).toMatchObject({ status: "pending" });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "done" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.state_repair",
        issue_id: issueID,
        payload_json: expect.stringContaining("done_missing_verification_evidence")
      });
    } finally {
      await fixture.close();
    }
  });

  test("delegated mode auto-executes authorized repair and records evidence", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, {
        attemptCount: 1,
        error: "network error",
        status: "failed",
        title: "Retry now",
        updatedAt: "2026-01-01T00:00:00Z"
      });

      const result = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.state_repair", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated"
        },
        project: fixture.project
      }).createIssueStateRepairProposal({ issue_id: issueID }) as { decision: string; status: string };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo", auto_retry_next_at: "", error: "" });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "issue.state_repair",
        gate_decision: "execute"
      }));
      expect(listIssueEvents(fixture.db, issueID)).toContainEqual(expect.objectContaining({
        type: "issue.state_manager_repair",
        payload: expect.stringContaining("failed_retry_ready")
      }));
    } finally {
      await fixture.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: {
  attemptCount?: number; autoRetryNextAt?: string; autoRetryReason?: string; codexThreadID?: string;
  error?: string; status: string; title: string; updatedAt: string;
}): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, attempt_count, codex_thread_id, auto_retry_next_at,
       auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", issue.title, issue.status, issue.error ?? "", issue.attemptCount ?? 0,
      issue.codexThreadID ?? "", issue.autoRetryNextAt ?? "", issue.autoRetryReason ?? "",
      issue.updatedAt, issue.updatedAt]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number, run: { endedAt: string; sessionID: string; status: string }): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, run.status, "codex", run.sessionID,
      "2026-01-01T00:10:00Z", run.endedAt, "provider_completed"]
  );
}

function insertSession(db: RunnerDatabase, issueID: number, input: { sessionID: string; status: string; updatedAt: string }): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${input.sessionID}`, "codex", input.sessionID, "demo", issueID, "Thread",
      input.status, "{}", "2026-01-01T00:00:00Z", input.updatedAt]
  );
}

function insertEvent(db: RunnerDatabase, issueID: number, type: string, payload: unknown): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), "2026-01-01T00:05:00Z"]
  );
}
