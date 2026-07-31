import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listPiRecoveryAttempts } from "../db/repositories/pi/recoveryAttempts.ts";
import { applyIssueStateRepair, recommendedRepairPayload } from "./issueStateManager.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue state repair executor", () => {
  test("executes comment, enqueue, retry, and move_status repairs with audit", async () => {
    const db = await openFixture();
    try {
      const commented = insertIssue(db, "in_progress", "Stale");
      const queued = insertIssue(db, "todo", "Queue me");
      const retried = insertIssue(db, "failed", "Retry me", "network error");
      db.sqlite.run("update issues set auto_retry_next_at=? where id=?", ["2026-01-01T00:00:00Z", retried]);
      const moved = insertIssue(db, "done", "Weak done");
      const running = insertIssue(db, "in_progress", "Other running");
      insertOpenRun(db, running);

      applyIssueStateRepair(db, recommendedRepairPayload(db, commented, {
        diagnosisCode: "stale_in_progress", operation: "comment"
      }));
      applyIssueStateRepair(db, recommendedRepairPayload(db, queued, {
        diagnosisCode: "todo_without_session", operation: "enqueue"
      }));
      applyIssueStateRepair(db, recommendedRepairPayload(db, retried, {
        diagnosisCode: "failed_retry_ready", operation: "retry"
      }));
      const result = applyIssueStateRepair(db, recommendedRepairPayload(db, moved, {
        diagnosisCode: "done_missing_verification_evidence",
        operation: "patch_status"
      }));

      expect(result).toMatchObject({ status: "pending_verification" });
      expect(getIssue(db, queued)).toMatchObject({ status: "todo" });
      expect(getIssue(db, retried)).toMatchObject({ status: "todo", error: "" });
      expect(getIssue(db, moved)).toMatchObject({ status: "pending_verification" });
      expect(openRunCount(db)).toBe(1);
      expect(listIssueEvents(db, commented).map((event) => event.type)).toEqual([
        "issue.comment", "issue.state_manager_repair"
      ]);
      expect(listIssueEvents(db, moved)).toContainEqual(expect.objectContaining({
        type: "issue.state_manager_repair",
        payload: expect.stringContaining('"runner_executor_busy":true')
      }));
    } finally {
      db.close();
    }
  });

  test("aborts without mutating the issue when expected state changes", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "done", "Weak done");
      const payload = recommendedRepairPayload(db, issueID, {
        diagnosisCode: "done_missing_verification_evidence",
        operation: "patch_status"
      });
      updateIssue(db, issueID, { status: "triage" });

      expect(() => applyIssueStateRepair(db, payload)).toThrow(/precondition|changed/i);

      expect(getIssue(db, issueID)).toMatchObject({ status: "triage" });
      expect(listIssueEvents(db, issueID).map((event) => event.type)).toEqual(["issue.status_changed"]);
      expect(listPiRecoveryAttempts(db, { issueId: issueID })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("records before and after snapshots on deterministic repairs", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "done", "Weak done");
      const payload = recommendedRepairPayload(db, issueID, {
        diagnosisCode: "done_missing_verification_evidence",
        operation: "patch_status"
      });

      applyIssueStateRepair(db, payload);

      const repairEvent = listIssueEvents(db, issueID)
        .find((event) => event.type === "issue.state_manager_repair");
      const audit = JSON.parse(repairEvent?.payload ?? "{}") as Record<string, unknown>;
      const before = objectPayload(audit.before_snapshot);
      const after = objectPayload(audit.after_snapshot);
      expect(objectPayload(before.issue)).toMatchObject({ status: "done" });
      expect(objectPayload(after.issue)).toMatchObject({ status: "pending_verification" });

      const attempts = listPiRecoveryAttempts(db, { issueId: issueID });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        action_type: "issue.state_repair",
        diagnosis_code: "done_missing_verification_evidence",
        status: "progress"
      });
      expect(JSON.parse(attempts[0].before_snapshot_json)).toMatchObject({
        issue: { status: "done" }
      });
      expect(JSON.parse(attempts[0].after_snapshot_json)).toMatchObject({
        issue: { status: "pending_verification" }
      });
    } finally {
      db.close();
    }
  });

  test("reconciles an open Run whose provider Session already completed", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "in_progress", "Terminal provider session");
      db.sqlite.run(
        "update issues set codex_thread_id=?, codex_turn_id=? where id=?",
        ["thread-terminal", "turn-terminal", issueID]
      );
      insertOpenRun(db, issueID);
      db.sqlite.run(
        `update issue_runs set provider='codex', provider_session_id=?, provider_turn_id=? where issue_id=?`,
        ["thread-terminal", "turn-terminal", issueID]
      );
      db.sqlite.run(
        `insert into agent_sessions
          (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
         values (?, 'codex', ?, 'demo', ?, 'completed', ?, ?, ?)`,
        [
          "codex:thread-terminal",
          "thread-terminal",
          issueID,
          JSON.stringify({ provider_turn_id: "turn-terminal" }),
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:10:00Z"
        ]
      );

      const payload = recommendedRepairPayload(db, issueID, {
        diagnosisCode: "in_progress_session_ended",
        operation: "patch_status"
      });
      const result = applyIssueStateRepair(db, payload);

      expect(result).toMatchObject({ status: "pending_verification" });
      expect(openRunCount(db)).toBe(0);
      expect(db.sqlite.query<Record<string, unknown>, [number]>(
        "select status, ended_at, exit_reason from issue_runs where issue_id=?"
      ).get(issueID)).toMatchObject({
        status: "done",
        ended_at: expect.any(String),
        exit_reason: "state_repair:in_progress_session_ended"
      });
      expect(db.sqlite.query<Record<string, unknown>, [number]>(`
        select attempt.status, attempt.terminal_source_ref
        from run_attempts attempt join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=? order by attempt.sequence desc limit 1
      `).get(issueID)).toMatchObject({
        status: "succeeded",
        terminal_source_ref: `issue_runs:issue-${issueID}-attempt-1`
      });
      expect(listIssueEvents(db, issueID).map((event) => event.type)).toEqual([
        "issue.run_terminal_reconciled",
        "issue.status_changed",
        "issue.state_manager_repair"
      ]);
    } finally {
      db.close();
    }
  });

  test("does not let a legacy verifier report bypass the Evidence Policy done gate", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "pending_verification", "Legacy verifier report");
      db.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
        [issueID, "issue.verification_report", JSON.stringify({ recommendation: "accept", summary: "tests passed" }), "2026-01-01T00:01:00Z"]
      );
      const payload = recommendedRepairPayload(db, issueID, {
        diagnosisCode: "pending_verification_has_evidence",
        operation: "patch_status"
      });

      const result = applyIssueStateRepair(db, payload);
      const events = listIssueEvents(db, issueID);

      expect(result).toMatchObject({ status: "pending_verification" });
      expect(getIssue(db, issueID)).toMatchObject({ status: "pending_verification" });
      expect(events.map((event) => event.type)).toEqual([
        "issue.verification_report",
        "issue.verification_gate_intent.v1",
        "issue.verification_gate_outcome.v1",
        "issue.verification_report",
        "issue.state_manager_repair"
      ]);
      expect(JSON.parse(events[2].payload)).toMatchObject({
        evaluation: { decision: "pending", satisfied: false },
        projection_errors: ["legacy state-repair evidence is not trusted structured Evidence"],
        target_status: "pending_verification"
      });
    } finally {
      db.close();
    }
  });
});

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-state-repair-executor-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, status: string, title: string, error = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", title, status, error, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function openRunCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>(
    "select count(*) as count from issue_runs where ended_at=''"
  ).get()?.count ?? 0;
}
