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
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import type { PiSupervisorDecisionRuntimeResult } from "../pi/issueSupervisorDecision.ts";
import type { PiSupervisorDecisionJson } from "../pi/issueSupervisorRecovery.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor scheduler", () => {
  test("uses the five-minute scheduler stale threshold when no override is provided", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-default-stale-project-"));
      insertRunningIssue(db, {
        issueID: 497,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:54:00Z",
        threadID: "thread-497",
        turnID: "turn-497"
      });

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          calls += 1;
          return validDecision(noopDecision());
        }
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1 });
      expect(calls).toBe(1);
      expect(listIssueSupervisorEvents(db, { issueId: 497 }))
        .toContainEqual(expect.objectContaining({
          diagnosis_code: "session_no_recent_progress",
          event_type: "signal"
        }));
    } finally {
      db.close();
    }
  });

  test("invokes PI for a dispatchable watchdog signal instead of stopping at a hardcoded candidate", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-watchdog-project-"));
      insertRunningIssue(db, {
        issueID: 498,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-498",
        turnID: "turn-498"
      });
      insertIssueEvent(db, 498, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          calls += 1;
          return validDecision(noopDecision());
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1, skipped: 0 });
      expect(calls).toBe(1);
      expect(listIssueSupervisorEvents(db, { issueId: 498 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action", "result"]);
      expect(listPiActions(db, { issueId: 498 })).toContainEqual(expect.objectContaining({
        action_type: "issue.supervisor_decision",
        status: "completed"
      }));
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("applies the valid PI decision through Action Gate and executor provider", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-autonomous-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 500,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-500",
        turnID: "turn-500"
      });
      insertIssueEvent(db, 500, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        runDecision: async () => validDecision(resumeDecision()),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(provider.calls).toEqual([{
        prompt: "Inspect current state and continue safely.",
        sessionId: "thread-500"
      }]);
      expect(listPiActions(db, { issueId: 500 })).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        gate_decision: "execute",
        status: "completed"
      }));
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("keeps issue lifecycle unchanged when PI output is invalid", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-invalid-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["needs_user.escalate"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 501,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-501",
        turnID: "turn-501"
      });
      insertIssueEvent(db, 501, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
      const alarm = needsUserDecision("PI Supervisor returned invalid JSON.");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => ({
          decision: alarm,
          error: "invalid supervisor decision JSON",
          raw_text: "not json",
          valid: false
        }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 1, signaled: 1 });
      expect(listPiActions(db, { issueId: 501 })).toEqual([]);
      expect(db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(501))
        .toEqual({ status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("cooldowns an audited invalid decision before asking PI again", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-invalid-cooldown-project-"));
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        supervisor_cooldown_seconds: 300,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 507,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-507",
        turnID: "turn-507"
      });
      insertIssueEvent(db, 507, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
      createIssueSupervisorEvent(db, {
        decision: "noop",
        diagnosis_code: "executor_stream_disconnected",
        event_type: "decision_failed",
        issue_id: 507,
        project_id: "demo",
        created_at: "2026-06-10T07:59:00Z"
      });
      db.sqlite.run(
        "update issue_supervisor_events set created_at=? where issue_id=? and event_type='decision_failed'",
        ["2026-06-10T07:59:00Z", 507]
      );
      const runDecision = async () => {
        calls += 1;
        return validDecision(noopDecision());
      };

      const cooling = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision,
        staleAfterSeconds: 300
      });
      const due = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:04:01Z"),
        runDecision,
        staleAfterSeconds: 300
      });

      expect(cooling).toMatchObject({ decisions: 0, skipped: 1 });
      expect(due).toMatchObject({ decisions: 1, signaled: 1 });
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("does not let a legacy action after an invalid decision suppress recovery forever", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-legacy-invalid-action-project-"));
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        supervisor_cooldown_seconds: 300,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 508,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-508",
        turnID: "turn-508"
      });
      insertIssueEvent(db, 508, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
      createIssueSupervisorEvent(db, {
        decision: "needs_user",
        diagnosis_code: "executor_stream_disconnected",
        event_type: "decision_failed",
        issue_id: 508,
        project_id: "demo"
      });
      createIssueSupervisorEvent(db, {
        action_type: "needs_user.escalate",
        decision: "needs_user",
        diagnosis_code: "executor_stream_disconnected",
        event_type: "action",
        issue_id: 508,
        project_id: "demo"
      });
      db.sqlite.run(
        "update issue_supervisor_events set created_at=? where issue_id=?",
        ["2026-06-10T07:50:00Z", 508]
      );

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          calls += 1;
          return validDecision(noopDecision());
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, signaled: 1, skipped: 0 });
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("raises an alert-only Guardian event when the PI Agent is missing or disabled", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-unavailable-project-"));
      db.sqlite.run("update pi_agents set enabled=0 where id='runner-default'");
      insertRunningIssue(db, {
        issueID: 502,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-502",
        turnID: "turn-502"
      });
      insertIssueEvent(db, 502, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, failed: 1, signaled: 1 });
      expect(listPiActions(db, { issueId: 502 })).toEqual([]);
      expect(listIssueSupervisorEvents(db, { issueId: 502 })).toContainEqual(expect.objectContaining({
        decision: "needs_user",
        event_type: "decision_failed"
      }));
      const [alert] = listPiGuardianEvents(db, { projectId: "demo" });
      expect(alert).toMatchObject({
        event_type: "guardian.pi_supervisor.unavailable",
        issue_id: 502,
        severity: "actionable",
        status: "pending"
      });
      expect(JSON.parse(alert?.normalized_payload_json ?? "{}")).toMatchObject({
        diagnosis_code: "pi_supervisor_unavailable",
        requires_user: true
      });
    } finally {
      db.close();
    }
  });

  test("off mode and normally active sessions do not call PI", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-skip-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "off" });
      insertRunningIssue(db, {
        issueID: 503,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:59:30Z",
        threadID: "thread-503",
        turnID: "turn-503"
      });

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          calls += 1;
          return validDecision(noopDecision());
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, signaled: 0 });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("ignores stale retry metadata on a completed issue", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-completed-stale-retry-"));
      insertRunningIssue(db, {
        issueID: 509,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-509",
        turnID: "turn-509"
      });
      db.sqlite.run(
        "update issues set status='done', auto_retry_next_at='2026-06-10T07:00:00Z' where id=509"
      );
      db.sqlite.run(
        "update issue_runs set status='done', ended_at='2026-06-10T07:50:00Z' where issue_id=509"
      );

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          calls += 1;
          return validDecision(noopDecision());
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, scanned: 0, signaled: 0 });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("retries a failed transient issue deterministically when PI runtime is unavailable", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-deterministic-transient-retry-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 510,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-510",
        turnID: "turn-510"
      });
      db.sqlite.run(
        "update issues set status='failed', error=? where id=510",
        ["needs_user: session_no_recent_progress\nXuanwu Supervisor failed to return a valid decision. Check the configured Agent/model/provider and its decision audit before retrying."]
      );
      db.sqlite.run(
        "update issue_runs set status='failed', ended_at='2026-06-10T07:50:00Z' where issue_id=510"
      );

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(db.sqlite.query<{ status: string }, [number]>(
        "select status from issues where id=?"
      ).get(510)).toEqual({ status: "todo" });
      expect(listIssueSupervisorEvents(db, { issueId: 510 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action", "result"]);
      expect(listPiActions(db, { issueId: 510 })).toContainEqual(expect.objectContaining({
        action_type: "issue.retry",
        status: "completed"
      }));
    } finally {
      db.close();
    }
  });

  test("honors recovery cooldown before asking PI for another decision", async () => {
    const db = await fixtureDb();
    let calls = 0;
    try {
      insertProject(db, "demo", await tempRoot("supervisor-cooldown-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.supervisor_decision"],
        project_id: "demo",
        supervisor_cooldown_seconds: 300,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 506,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-506",
        turnID: "turn-506"
      });
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
      const runDecision = async () => {
        calls += 1;
        return validDecision(noopDecision());
      };

      const waiting = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision,
        staleAfterSeconds: 300
      });
      const due = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:05:01Z"),
        runDecision,
        staleAfterSeconds: 300
      });

      expect(waiting).toMatchObject({ decisions: 0, signaled: 0 });
      expect(due).toMatchObject({ decisions: 1, signaled: 1 });
      expect(calls).toBe(1);
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
    values (?, ?, ?, 'codex', 1, 1, ?, ?)`, [
    projectID,
    projectID,
    cwd,
    "2026-06-10T07:00:00Z",
    "2026-06-10T07:00:00Z"
  ]);
}

function insertRunningIssue(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionUpdatedAt: string;
  threadID: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`, [
    input.issueID,
    input.projectID,
    "2026-06-10T07:00:00Z",
    input.sessionUpdatedAt
  ]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, '2026-06-10T07:00:00Z', '')`, [
    `issue-${input.issueID}-attempt-1`,
    input.issueID,
    input.threadID,
    input.turnID
  ]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, '2026-06-10T07:00:00Z', ?)`, [
    `codex:${input.threadID}`,
    input.threadID,
    input.projectID,
    input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }),
    input.sessionUpdatedAt
  ]);
}

function insertIssueEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: unknown,
  createdAt: string,
  type = "issue.log"
): void {
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
    [issueID, type, JSON.stringify(payload), createdAt]
  );
}

function validDecision(decision: PiSupervisorDecisionJson): PiSupervisorDecisionRuntimeResult {
  return { decision, raw_text: JSON.stringify(decision), valid: true };
}

function noopDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "noop",
    evidence_refs: ["latest_run", "session"],
    expected_outcome: "no state changes before more evidence arrives",
    fallback_if_no_progress: "needs_user",
    rationale: "PI found no safe recovery action",
    recovery_message: "",
    risk_level: "low"
  };
}

function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "resume_session",
    evidence_refs: ["provider_error"],
    expected_outcome: "session emits new progress",
    fallback_if_no_progress: "needs_user",
    rationale: "stream disconnected after stale threshold",
    recovery_message: "Inspect current state and continue safely.",
    risk_level: "medium"
  };
}

function needsUserDecision(message: string): PiSupervisorDecisionJson {
  return {
    confidence: "low",
    decision: "needs_user",
    evidence_refs: ["supervisor_decision_invalid"],
    expected_outcome: "a human repairs PI before recovery",
    fallback_if_no_progress: "blocked",
    rationale: message,
    recovery_message: message,
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
    return {
      provider: "codex" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-followup"
    };
  }
}
