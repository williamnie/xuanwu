import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianAlerts,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts, recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor budget exhausted escalation", () => {
  test("applies a bounded needs-user boundary when recovery budget is exhausted", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-budget-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo"
      });
      insertRunningIssue(db, 505, "demo", "thread-505", "turn-505");
      for (const index of [1, 2, 3, 4, 5, 6]) recordBudgetAttempt(db, index);

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async (context) => {
          expect(context.recovery_history).toMatchObject({
            attempts_24h: 6,
            budget_remaining: 0,
            budget_status: "issue_budget_exhausted",
            project_budget_unlimited: true
          });
          return {
            decision: {
              confidence: "high",
              decision: "needs_user",
              evidence_refs: ["recovery_budget"],
              expected_outcome: "automatic recovery stops at the Issue boundary",
              fallback_if_no_progress: "blocked",
              rationale: "Issue recovery budget is exhausted.",
              recovery_message: "Review the latest recovery evidence.",
              risk_level: "medium"
            },
            raw_text: "needs_user",
            valid: true
          };
        },
        staleAfterSeconds: 300
      });
      const events = listIssueSupervisorEvents(db, { issueId: 505 });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1, skipped: 0 });
      expect(events.map((event) => event.event_type)).toEqual(["signal", "decision", "action", "result"]);
      expect(events[0]).toMatchObject({
        diagnosis_code: "recovery_budget_exhausted",
        event_type: "signal",
        issue_id: 505
      });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toContainEqual(
        expect.objectContaining({ alert_type: "supervisor_needs_user", issue_id: 505 })
      );
      expect(listPiActions(db, { issueId: 505 })).toContainEqual(
        expect.objectContaining({ action_type: "needs_user.escalate", status: "completed" })
      );
      expect(listPiRecoveryAttempts(db, { issueId: 505 })).toHaveLength(6);

      const second = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:01:00Z"),
        staleAfterSeconds: 300
      });
      expect(second).toMatchObject({ signaled: 1, skipped: 1 });
      expect(listIssueSupervisorEvents(db, { issueId: 505 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action", "result"]);
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
  db.sqlite.run(`insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
    [projectID, "2026-06-10T07:00:00Z", "2026-06-10T07:00:00Z"]);
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
