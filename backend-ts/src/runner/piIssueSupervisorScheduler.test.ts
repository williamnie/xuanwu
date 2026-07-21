import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianEvents,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import type { PiSupervisorDecisionJson } from "../pi/issueSupervisorRecovery.ts";
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { runGuardianDecisionOrchestratorOnce } from "../pi/guardianDecisionOrchestrator.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor scheduler", () => {
  test("default watchdog policy records only supervisor signal and Guardian inbox", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-watchdog-project-"));
      insertRunningIssue(db, { issueID: 498, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-498", turnID: "turn-498" });
      insertIssueEvent(db, 498, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => { throw new Error("supervisor must not call PI decision"); },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 1, skipped: 1 });
      expect(listPiActions(db, { issueId: 498 })).toEqual([]);
      expect(listIssueSupervisorEvents(db, { issueId: 498 }).map((event) => event.event_type)).toEqual(["signal"]);
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toContainEqual(expect.objectContaining({
        event_type: "guardian.supervisor.candidate",
        issue_id: 498,
        severity: "watch",
        source: "supervisor"
      }));
    } finally {
      db.close();
    }
  });

  test("propose/autonomous inputs do not create decisions, actions, or provider calls", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-propose-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "autonomous", allowed_supervisor_actions_json: ["session.resume_followup"] });
      insertRunningIssue(db, { issueID: 500, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-500", turnID: "turn-500" });
      insertIssueEvent(db, 500, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        runDecision: async () => ({ decision: resumeDecision(), raw_text: JSON.stringify(resumeDecision()), valid: true }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 1, skipped: 1 });
      expect(provider.calls).toEqual([]);
      expect(listPiActions(db, { issueId: 500 })).toEqual([]);
      expect(listIssueSupervisorEvents(db, { issueId: 500 }).map((event) => event.event_type)).toEqual(["signal"]);
    } finally {
      db.close();
    }
  });

  test("autonomous supervisor signal can be planned into a gated recovery action later", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-planner-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "autonomous", allowed_supervisor_actions_json: ["session.resume_followup"] });
      insertRunningIssue(db, { issueID: 501, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-501", turnID: "turn-501" });
      insertIssueEvent(db, 501, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        staleAfterSeconds: 300
      });
      const queued = runGuardianDecisionOrchestratorOnce(db, { now: NOW });
      const settled = runGuardianDecisionOrchestratorOnce(db, { now: new Date(NOW.getTime() + 31_000) });
      const [action] = listPiActions(db, { issueId: 501 });

      expect(result).toMatchObject({ decisions: 0, signaled: 1 });
      expect(queued).toMatchObject({ created: 1, scanned: 1 });
      expect(settled).toMatchObject({ leases_acquired: 1, scanned: 0 });
      expect(action).toMatchObject({
        action_type: "session.resume_followup",
        gate_decision: "execute",
        status: "approved"
      });
      expect(JSON.parse(action?.payload_json ?? "{}")).toMatchObject({
        expected_provider_turn_id: "turn-501",
        expected_run_id: "issue-501-attempt-1",
        expected_session_updated_at: "2026-06-10T07:45:00Z",
        provider_session_id: "thread-501"
      });
      expect(provider.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("plans an autonomous retry for a recent failed executor attempt", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-failed-retry-project-"));
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        supervisor_mode: "autonomous",
        allowed_supervisor_actions_json: ["issue.retry", "needs_user.escalate"]
      });
      insertFailedIssue(db, 507, "demo");

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW });
      const queued = runGuardianDecisionOrchestratorOnce(db, { now: NOW });
      const settled = runGuardianDecisionOrchestratorOnce(db, { now: new Date(NOW.getTime() + 31_000) });
      const [action] = listPiActions(db, { issueId: 507 });

      expect(result).toMatchObject({ scanned: 1, signaled: 1 });
      expect(queued).toMatchObject({ created: 1, scanned: 1 });
      expect(settled).toMatchObject({ leases_acquired: 1 });
      expect(action).toMatchObject({ action_type: "issue.retry", gate_decision: "execute", status: "approved" });
      expect(JSON.parse(action?.payload_json ?? "{}")).toMatchObject({
        diagnosis_code: "scheduler_retryable_error",
        expected_issue_status: "failed",
        expected_run_id: "issue-507-attempt-1"
      });
    } finally {
      db.close();
    }
  });

  test("off supervisor mode skips analysis and does not write signals", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-off-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "off" });
      insertRunningIssue(db, { issueID: 499, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-499", turnID: "turn-499" });
      insertIssueEvent(db, 499, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 0, skipped: 0 });
      expect(listIssueSupervisorEvents(db, { issueId: 499 })).toEqual([]);
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rate limited provider failures become transient watch Guardian signals", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-rate-limit-project-"));
      insertRunningIssue(db, { issueID: 502, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-502", turnID: "turn-502" });
      insertIssueEvent(db, 502, { provider: "codex", raw_payload: "HTTP 429 too many requests", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const [event] = listPiGuardianEvents(db, { projectId: "demo" });

      expect(result).toMatchObject({ decisions: 0, failed: 0, signaled: 1, skipped: 1 });
      expect(event).toMatchObject({ issue_id: 502, severity: "watch" });
      expect(JSON.parse(event?.normalized_payload_json ?? "{}")).toMatchObject({
        classification: { failure_class: "transient", severity: "watch" },
        diagnosis_code: "provider_rate_limited",
        provider_error_category: "rate_limit"
      });
    } finally {
      db.close();
    }
  });

  test("scheduled retry-after stays quiet before due and re-enters planner when due", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-retry-after-due-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "autonomous", allowed_supervisor_actions_json: ["issue.retry_after", "issue.retry"] });
      insertRunningIssue(db, { issueID: 504, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-504", turnID: "turn-504" });
      db.sqlite.run("update issues set auto_retry_next_at=?, auto_retry_reason=? where id=?", [
        "2026-06-10T08:10:00Z", "provider_rate_limited", 504
      ]);
      insertIssueEvent(db, 504, {
        reason: "provider_rate_limited",
        retry_after_at: "2026-06-10T08:10:00Z"
      }, "2026-06-10T08:00:00Z", "issue.retry_after_scheduled");

      const waiting = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(waiting).toMatchObject({ decisions: 0, failed: 0, signaled: 0, skipped: 0 });
      expect(listIssueSupervisorEvents(db, { issueId: 504 })).toEqual([]);
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);

      const due = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:11:00Z"),
        staleAfterSeconds: 300
      });

      expect(due).toMatchObject({ decisions: 0, failed: 0, signaled: 1, skipped: 1 });
      expect(JSON.parse(listPiGuardianEvents(db, { projectId: "demo" })[0]?.normalized_payload_json ?? "{}"))
        .toMatchObject({ diagnosis_code: "provider_retry_after_ready", retry_after_ready: "true" });
      const queued = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-10T08:11:00Z") });
      const settled = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-10T08:11:31Z") });

      expect(queued).toMatchObject({ created: 1, scanned: 1 });
      expect(settled).toMatchObject({ leases_acquired: 1, scanned: 0 });
      expect(listPiActions(db, { issueId: 504 })[0]).toMatchObject({
        action_type: "issue.retry",
        gate_decision: "execute",
        status: "approved"
      });
    } finally {
      db.close();
    }
  });

  test("signals an idle executor session immediately instead of waiting for stale timeout", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-idle-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, { issueID: 505, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:59:30Z", threadID: "thread-505", turnID: "turn-505" });
      db.sqlite.run("update agent_sessions set status='idle' where session_key='codex:thread-505'");

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const [event] = listPiGuardianEvents(db, { projectId: "demo" });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 1, skipped: 1 });
      expect(event).toMatchObject({ event_type: "guardian.supervisor.candidate", issue_id: 505 });
      expect(JSON.parse(event?.normalized_payload_json ?? "{}")).toMatchObject({
        diagnosis_code: "session_no_recent_progress",
        ready: true,
        session_status: "idle",
        stale_gap_seconds: 30
      });
    } finally {
      db.close();
    }
  });

  test("does not mark a normally active executor session as stale", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-active-project-"));
      insertRunningIssue(db, { issueID: 503, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:59:30Z", threadID: "thread-503", turnID: "turn-503" });

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(result).toMatchObject({ decisions: 0, scanned: 1, signaled: 0 });
      expect(listIssueSupervisorEvents(db, { issueId: 503 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("waits for recovery cooldown before emitting another transient action", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-cooldown-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry"],
        project_id: "demo",
        supervisor_cooldown_seconds: 300,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, { issueID: 506, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-506", turnID: "turn-506" });
      db.sqlite.run("update agent_sessions set status='idle' where session_key='codex:thread-506'");
      createIssueSupervisorEvent(db, {
        action_type: "issue.retry",
        event_type: "action",
        issue_id: 506,
        project_id: "demo"
      });
      recordPiRecoveryAttempt(db, {
        action_type: "issue.retry",
        budget_window_started_at: "2026-06-09T08:00:00Z",
        created_at: "2026-06-10T07:59:00Z",
        diagnosis_code: "session_no_recent_progress",
        id: "cooldown-506",
        idempotency_key: "cooldown-506",
        issue_id: 506,
        project_id: "demo",
        status: "progress",
        updated_at: "2026-06-10T07:59:00Z"
      });

      const waiting = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const due = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:05:01Z"),
        staleAfterSeconds: 300
      });

      expect(waiting).toMatchObject({ signaled: 0 });
      expect(due).toMatchObject({ signaled: 1 });
    } finally {
      db.close();
    }
  });

  test("does not let retry-after scheduling delay a due provider retry window", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-retry-after-cooldown-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry_after", "issue.retry"],
        project_id: "demo",
        supervisor_cooldown_seconds: 300,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, { issueID: 507, projectID: "demo", sessionUpdatedAt: "2026-06-10T07:45:00Z", threadID: "thread-507", turnID: "turn-507" });
      db.sqlite.run("update issues set auto_retry_next_at=?, auto_retry_reason=? where id=?", [
        "2026-06-10T07:59:30Z", "provider_rate_limited", 507
      ]);
      insertIssueEvent(db, 507, {
        reason: "provider_rate_limited",
        retry_after_at: "2026-06-10T07:59:30Z"
      }, "2026-06-10T07:59:00Z", "issue.retry_after_scheduled");
      recordPiRecoveryAttempt(db, {
        action_type: "issue.retry_after",
        budget_window_started_at: "2026-06-09T08:00:00Z",
        created_at: "2026-06-10T07:59:00Z",
        diagnosis_code: "provider_retry_after_waiting",
        id: "retry-after-507",
        idempotency_key: "retry-after-507",
        issue_id: 507,
        project_id: "demo",
        status: "planned",
        updated_at: "2026-06-10T07:59:00Z"
      });

      const due = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(due).toMatchObject({ signaled: 1 });
      expect(JSON.parse(listPiGuardianEvents(db, { projectId: "demo" })[0]?.normalized_payload_json ?? "{}"))
        .toMatchObject({ diagnosis_code: "provider_retry_after_ready", retry_after_ready: "true" });
    } finally {
      db.close();
    }
  });

});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-scheduler-db-");
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

function insertRunningIssue(db: RunnerDatabase, input: {
  issueID: number; projectID: string; sessionUpdatedAt: string; threadID: string; turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`,
  [input.issueID, input.projectID, "2026-06-10T07:00:00Z", input.sessionUpdatedAt]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, '2026-06-10T07:00:00Z', '')`,
  [`issue-${input.issueID}-attempt-1`, input.issueID, input.threadID, input.turnID]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, '2026-06-10T07:00:00Z', ?)`,
  [`codex:${input.threadID}`, input.threadID, input.projectID, input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }), input.sessionUpdatedAt]);
}

function insertFailedIssue(db: RunnerDatabase, issueID: number, projectID: string): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, error, created_at, updated_at)
    values (?, ?, 'Failed supervisor issue', 'failed', 1, 'focused tests failed', ?, ?)`,
  [issueID, projectID, "2026-06-10T07:00:00Z", "2026-06-10T07:50:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at, error)
    values (?, ?, 1, 'failed', 'codex', ?, ?, '2026-06-10T07:00:00Z', '2026-06-10T07:50:00Z', 'focused tests failed')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, `turn-${issueID}`]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'failed', ?, '2026-06-10T07:00:00Z', '2026-06-10T07:50:00Z')`,
  [`codex:thread-${issueID}`, `thread-${issueID}`, projectID, issueID,
    JSON.stringify({ provider_turn_id: `turn-${issueID}` })]);
  insertIssueEvent(db, issueID, {
    provider: "codex",
    raw_payload: "focused test failed: expected status 200",
    status: "failed",
    type: "error"
  }, "2026-06-10T07:49:59Z");
}

function insertIssueEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: unknown,
  createdAt: string,
  type = "issue.log"
): void {
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), createdAt]);
}

function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high", decision: "resume_session", evidence_refs: ["provider_error"],
    expected_outcome: "session emits new progress", fallback_if_no_progress: "needs_user",
    rationale: "stream disconnected after stale threshold", recovery_message: "Inspect current state and continue safely.",
    risk_level: "medium"
  };
}

class SupervisorProvider implements ExecutorProvider {
  readonly calls: Record<string, unknown>[] = [];
  readonly capabilities = ["resume_session"] as const;
  readonly id = "codex" as const;

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt, sessionId: input.sessionId });
    return { provider: "codex" as const, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "turn-followup" };
  }
}
