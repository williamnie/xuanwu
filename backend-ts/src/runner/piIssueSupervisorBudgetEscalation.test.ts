import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianEvents,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts, recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { runGuardianDecisionOrchestratorOnce } from "../pi/guardianDecisionOrchestrator.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor budget exhausted escalation", () => {
  test("writes reportable needs-user signal without planning recovery", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-budget-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, 505, "demo", "thread-505", "turn-505");
      for (const index of [1, 2]) recordBudgetAttempt(db, index);

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const events = listIssueSupervisorEvents(db, { issueId: 505 });
      const payload = JSON.parse(events[0]?.payload_json ?? "{}");
      const guardian = listPiGuardianEvents(db, { projectId: "demo" })[0];

      expect(result).toMatchObject({ decisions: 0, failed: 0, signaled: 1, skipped: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action_type: "needs_user.escalate",
        decision: "needs_user",
        diagnosis_code: "recovery_budget_exhausted",
        event_type: "budget_exhausted",
        issue_id: 505
      });
      expect(payload).toMatchObject({
        attempts_24h: 2,
        count: 2,
        diagnosis_code: "recovery_budget_exhausted",
        issue_id: 505,
        last_action_at: "2026-06-10T07:52:00Z",
        last_action_status: "failed",
        last_action_type: "issue.retry",
        last_recovery_attempt_id: "budget-505-2",
        outcome: "needs_user",
        report_status: "budget_exhausted",
        window: "24h",
        window_started_at: "2026-06-09T08:00:00Z"
      });
      expect(guardian).toMatchObject({
        event_type: "guardian.supervisor.candidate",
        issue_id: 505,
        severity: "actionable"
      });

      runGuardianDecisionOrchestratorOnce(db, { now: NOW });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-10T08:00:31Z") });
      expect(listPiActions(db, { issueId: 505 })[0]).toMatchObject({
        action_type: "needs_user.escalate",
        gate_decision: "execute",
        status: "approved"
      });
      expect(listPiRecoveryAttempts(db, { issueId: 505 })).toHaveLength(2);

      const second = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:01:00Z"),
        staleAfterSeconds: 300
      });
      expect(second).toMatchObject({ signaled: 1, skipped: 1 });
      expect(listIssueSupervisorEvents(db, { issueId: 505 }).map((event) => event.event_type))
        .toEqual(["budget_exhausted"]);
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-budget-db-");
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function insertProject(db: RunnerDatabase, projectID: string, cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, 1, ?, ?)`, [projectID, projectID, cwd, "2026-06-10T07:00:00Z", "2026-06-10T07:00:00Z"]);
}

function insertRunningIssue(db: RunnerDatabase, issueID: number, projectID: string, sessionID: string, turnID: string): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'failed', 1, ?, ?)`,
  [issueID, projectID, "2026-06-10T07:00:00Z", "2026-06-10T07:45:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'failed', 'codex', ?, ?, '2026-06-10T07:00:00Z', '2026-06-10T07:44:00Z')`,
  [`issue-${issueID}-attempt-1`, issueID, sessionID, turnID]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'failed', ?, '2026-06-10T07:00:00Z', '2026-06-10T07:45:00Z')`,
  [`codex:${sessionID}`, sessionID, projectID, issueID, JSON.stringify({ provider_turn_id: turnID })]);
}

function recordBudgetAttempt(db: RunnerDatabase, index: number): void {
  recordPiRecoveryAttempt(db, {
    action_type: index === 3 ? "session.resume_followup" : "issue.retry",
    budget_window_started_at: "2026-06-10T00:00:00Z",
    created_at: `2026-06-10T07:5${index}:00Z`,
    diagnosis_code: "provider_timeout",
    id: `budget-505-${index}`,
    idempotency_key: `budget-505-${index}`,
    issue_id: 505,
    project_id: "demo",
    session_id: "codex:thread-505",
    status: "failed",
    updated_at: `2026-06-10T07:5${index}:00Z`
  });
}
