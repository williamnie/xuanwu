import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { retryIssue } from "../db/repositories/issueActions.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts, recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI supervisor issue retry recovery attempts", () => {
  test("issue.retry_after records planned recovery attempt", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 306);

      await dispatchPiAction({ database: db }, retryAfterAction(db, 306));

      expect(listPiRecoveryAttempts(db, { issueId: 306 })).toContainEqual(expect.objectContaining({
        action_type: "issue.retry_after",
        diagnosis_code: "provider_rate_limited",
        source_decision_id: "retry-after-action-306",
        status: "planned"
      }));
    } finally {
      db.close();
    }
  });

  test("issue.retry writes progress attempt and ignores attempt_count budget", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 309);
      db.sqlite.run("update issue_runs set provider_session_id='', provider_turn_id='' where issue_id=309");
      db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at)
        values (309, 'issue.provider_deferred', '{}', '2026-06-10T07:00:00Z')`);
      db.sqlite.run("update issues set attempt_count=99 where id=?", [309]);

      await dispatchPiAction({ database: db }, retryAction(db, 309, "retry-action-309"));

      expect(listPiRecoveryAttempts(db, { issueId: 309 })).toContainEqual(expect.objectContaining({
        action_type: "issue.retry",
        diagnosis_code: "provider_transient_network_error",
        source_decision_id: "retry-action-309",
        status: "progress"
      }));
    } finally {
      db.close();
    }
  });

  test("issue.retry checks pi recovery budget before queueing", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 310);
      for (const index of [1, 2, 3]) recordBudgetAttempt(db, 310, index);

      await expect(dispatchPiAction({ database: db }, retryAction(db, 310, "retry-budget-action")))
        .rejects.toThrow("recovery budget is exhausted");

      expect(listPiRecoveryAttempts(db, { issueId: 310 })).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test("issue.retry records no_progress when an equivalent new Run request is already pending", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 311);
      db.sqlite.run("update issues set status='failed' where id=311");
      db.sqlite.run(
        "update issue_runs set status='failed', ended_at='2026-06-10T07:00:00Z' where issue_id=311"
      );
      retryIssue(db, 311);

      const result = await dispatchPiAction({ database: db }, retryAction(db, 311, "retry-noop-action"));

      expect(result).toMatchObject({ id: 311, status: "todo" });
      expect(listPiRecoveryAttempts(db, { issueId: 311 })).toContainEqual(expect.objectContaining({
        action_type: "issue.retry",
        ignored_reasons_json: "[\"retry_no_state_change\"]",
        progress_detected: 0,
        progress_reasons_json: "[]",
        status: "no_progress"
      }));
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-issue-recovery-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 0, ?, ?)`, [id, id, `/tmp/${id}`, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssueRunSession(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, 'demo', 'Supervisor issue', 'in_progress', ?, ?)`, [issueID, "2026-06-10T06:00:00Z", "2026-06-10T07:00:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, 'turn-old', ?, '')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, "2026-06-10T06:30:00Z"]);
}

function retryAfterAction(db: RunnerDatabase, issueID: number) {
  return createPiAction(db, {
    action_type: "issue.retry_after",
    id: `retry-after-action-${issueID}`,
    issue_id: issueID,
    payload_json: JSON.stringify({
      diagnosis_code: "provider_rate_limited",
      expected_issue_updated_at: "2026-06-10T07:00:00Z",
      expected_run_id: `issue-${issueID}-attempt-1`,
      issue_id: issueID,
      reason: "provider_rate_limited",
      retry_after_at: "2026-06-10T08:10:00Z"
    }),
    project_id: "demo",
    status: "approved"
  });
}

function retryAction(db: RunnerDatabase, issueID: number, id: string) {
  return createPiAction(db, {
    action_type: "issue.retry",
    id,
    issue_id: issueID,
    payload_json: JSON.stringify({
      diagnosis_code: "provider_transient_network_error",
      expected_issue_updated_at: "2026-06-10T07:00:00Z",
      expected_run_id: `issue-${issueID}-attempt-1`,
      issue_id: issueID,
      reason: "transient provider disconnect"
    }),
    project_id: "demo",
    status: "approved"
  });
}

function recordBudgetAttempt(db: RunnerDatabase, issueID: number, index: number): void {
  recordPiRecoveryAttempt(db, {
    action_type: "issue.retry",
    budget_window_started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    diagnosis_code: "provider_timeout",
    id: `budgeted-retry-${index}`,
    idempotency_key: `budgeted-retry-${index}`,
    issue_id: issueID,
    project_id: "demo",
    session_id: `codex:thread-${issueID}`,
    status: "failed",
    updated_at: new Date().toISOString()
  });
}
