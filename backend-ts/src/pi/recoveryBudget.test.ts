import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import type { PiGuardianEvent } from "../db/repositories/pi.ts";
import { guardianDecisionCandidate } from "./guardianDecisionMerge.ts";
import { readPiRecoveryBudget } from "./recoveryBudget.ts";

const NOW = new Date("2026-06-18T02:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI recovery budget", () => {
  test("honors the six-attempt issue recovery limit and ignores issues.attempt_count", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssue(db, 501, 99);
      recordAttempt(db, { id: "old", issueID: 501, status: "failed", at: "2026-06-16T23:59:00Z" });
      recordAttempt(db, { id: "cancelled", issueID: 501, status: "cancelled", at: "2026-06-18T01:10:00Z" });

      expect(readPiRecoveryBudget(db, budgetInput(501, "issue.retry"))).toMatchObject({
        issue_attempts_24h: 0,
        issue_budget_remaining: 6,
        status: "allow"
      });

      for (const [index, status] of ["planned", "failed", "progress", "no_progress", "executing", "failed"].entries()) {
        recordAttempt(db, {
          id: `issue-${index + 1}`,
          issueID: 501,
          status,
          at: `2026-06-18T01:2${index}:00Z`
        });
      }

      expect(readPiRecoveryBudget(db, budgetInput(501, "issue.retry"))).toMatchObject({
        diagnosis_code: "recovery_budget_exhausted",
        issue_attempts_24h: 6,
        issue_budget_remaining: 0,
        recommended_action: "budget_exhausted",
        status: "issue_budget_exhausted"
      });
    } finally {
      db.close();
    }
  });

  test("exhausts the seventh session resume without blocking other issue recoveries", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssue(db, 502, 1);
      for (const index of [1, 2, 3, 4, 5, 6]) {
        recordAttempt(db, {
          actionType: "session.resume_followup",
          id: `resume-${index}`,
          issueID: 502,
          sessionID: "codex:thread-502",
          status: "progress",
          at: `2026-06-18T01:${String(index).padStart(2, "0")}:00Z`
        });
      }

      expect(readPiRecoveryBudget(db, budgetInput(502, "session.resume_followup"))).toMatchObject({
        diagnosis_code: "session_recovery_exhausted",
        recommended_action: "budget_exhausted",
        session_resume_attempts_24h: 6,
        session_resume_budget_remaining: 0,
        status: "session_resume_exhausted"
      });
      expect(readPiRecoveryBudget(db, budgetInput(502, "issue.retry"))).toMatchObject({
        issue_attempts_24h: 6,
        issue_budget_remaining: 0,
        status: "issue_budget_exhausted"
      });
    } finally {
      db.close();
    }
  });

  test("keeps project recovery unlimited while retaining hourly attempt telemetry", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      for (let index = 0; index < 30; index++) {
        const issueID = 600 + index;
        insertIssue(db, issueID, 1);
        recordAttempt(db, {
          id: `project-${index}`,
          issueID,
          status: "no_progress",
          at: `2026-06-18T01:${String(20 + index).padStart(2, "0")}:00Z`
        });
      }

      expect(readPiRecoveryBudget(db, {
        ...budgetInput(601, "issue.retry"),
        projectLimit: 10
      })).toMatchObject({
        project_attempts_1h: 30,
        project_budget_remaining: 0,
        project_budget_unlimited: true,
        project_defer_until: "",
        project_limit: 0,
        recommended_action: "allow",
        status: "allow"
      });
    } finally {
      db.close();
    }
  });

  test("keeps budget exhausted guardian events actionable instead of watch aggregate", () => {
    const candidate = guardianDecisionCandidate(guardianEvent({
      diagnosis_code: "recovery_budget_exhausted",
      severity: "watch"
    }));

    expect(candidate).toMatchObject({
      decision: "needs_user",
      diagnosis_code: "recovery_budget_exhausted",
      requires_user: 1,
      severity: "actionable"
    });
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-recovery-budget-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function budgetInput(issueID: number, actionType: string) {
  return {
    actionType,
    issueID,
    now: NOW,
    projectID: "demo",
    sessionID: `codex:thread-${issueID}`
  };
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`, [id, id, `/tmp/${id}`, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"]);
}

function insertIssue(db: RunnerDatabase, issueID: number, attemptCount: number): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, 'demo', 'Budget issue', 'in_progress', ?, ?, ?)`,
  [issueID, attemptCount, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"]);
}

function recordAttempt(db: RunnerDatabase, input: {
  actionType?: string;
  at: string;
  id: string;
  issueID: number;
  sessionID?: string;
  status: string;
}): void {
  recordPiRecoveryAttempt(db, {
    action_type: input.actionType ?? "issue.retry",
    budget_window_started_at: "2026-06-18T00:00:00Z",
    created_at: input.at,
    diagnosis_code: "provider_timeout",
    id: input.id,
    idempotency_key: `recovery:${input.id}`,
    issue_id: input.issueID,
    project_id: "demo",
    session_id: input.sessionID ?? `codex:thread-${input.issueID}`,
    status: input.status,
    updated_at: input.at
  });
}

function guardianEvent(payload: Record<string, unknown>): PiGuardianEvent {
  return {
    consumed_at: "",
    conversation_id: "",
    created_at: "2026-06-18T02:00:00Z",
    error: "",
    event_type: "guardian.supervisor.candidate",
    id: "budget-event",
    idempotency_key: "budget-event",
    issue_id: 501,
    lease_expires_at: "",
    lease_owner: "",
    normalized_payload_json: JSON.stringify({ ...payload, signal_type: "supervisor.candidate" }),
    project_id: "demo",
    redaction_profile: "prompt",
    run_group_id: "",
    sequence_id: 1,
    severity: String(payload.severity ?? "watch"),
    source: "supervisor",
    source_event_id: "budget-event",
    source_sequence: 1,
    status: "pending",
    updated_at: "2026-06-18T02:00:00Z"
  };
}
