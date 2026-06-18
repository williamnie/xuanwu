import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { buildIssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor context builder", () => {
  test("builds #298 disconnect context with last error, open run, session id, and 6h stale gap", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-workspace-"));
      insertIssue(db, { id: 298, projectID: "runner", title: "Disconnected issue", status: "in_progress", updatedAt: "2026-06-10T02:00:00Z" });
      insertRun(db, { issueID: 298, id: "issue-298-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-298", turnID: "turn-298" });
      insertSession(db, { issueID: 298, projectID: "runner", sessionID: "thread-298", status: "running", updatedAt: "2026-06-10T02:00:00Z" });
      insertEvent(db, { issueID: 298, type: "issue.log", payload: {
        type: "text",
        text: "I inspected the current state and found the narrow failing path."
      }, createdAt: "2026-06-10T01:58:00Z" });
      insertEvent(db, { issueID: 298, type: "issue.log", payload: {
        type: "tool",
        command: "bun test backend-ts/src/pi/issueSupervisorContext.test.ts",
        status: "completed"
      }, createdAt: "2026-06-10T01:59:00Z" });
      insertEvent(db, { issueID: 298, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: { error: "Reconnecting... 1/5", api_key: "sk-live-secret", cwd: "/Users/xiaobei/private" }
      }, createdAt: "2026-06-10T02:00:00Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 298, { now: NOW });

      expect(context.issue).toMatchObject({ id: 298, status: "in_progress", attempt_count: 1 });
      expect(context.latest_run).toMatchObject({ id: "issue-298-attempt-1", status: "in_progress", ended_at: "" });
      expect(context.session).toMatchObject({
        provider_session_id: "thread-298",
        run_state: "open",
        status: "disconnected",
        stale_gap_seconds: 21_600
      });
      expect(context.provider_error).toMatchObject({
        category: "stream_disconnect",
        diagnosis_code: "executor_stream_disconnected"
      });
      expect(context.candidates.map((item) => item.diagnosis_code)).toContain("executor_stream_disconnected");
      expect(context.workspace_snapshot).toMatchObject({
        last_agent_message: "I inspected the current state and found the narrow failing path.",
        last_commands: ["bun test backend-ts/src/pi/issueSupervisorContext.test.ts"]
      });
      expect(context.recent_events.flatMap((event) => event.markers)).toEqual(expect.arrayContaining([
        "agent_message",
        "tool_command",
        "verification"
      ]));
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain("sk-live-secret");
      expect(serialized).not.toContain("/Users/xiaobei/private");
    } finally {
      db.close();
    }
  });

  test("shows 429 wait window and recovery budget", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-rate-limit-"));
      insertIssue(db, { id: 301, projectID: "runner", title: "Rate limited issue", status: "in_progress", updatedAt: "2026-06-10T07:55:00Z" });
      insertRun(db, { issueID: 301, id: "issue-301-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-301", turnID: "turn-301" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry_after", "session.resume_followup"],
        project_id: "runner",
        supervisor_max_recoveries_per_issue: 3,
        supervisor_max_recoveries_per_project_per_hour: 5
      });
      insertEvent(db, { issueID: 301, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: { status_code: 429, retry_after: 600, error: "too many requests" }
      }, createdAt: "2026-06-10T08:00:00Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 301, { now: NOW });

      expect(context.provider_error).toMatchObject({
        category: "rate_limit",
        status_code: 429,
        retry_after_at: "2026-06-10T08:10:00Z",
        retry_after_seconds: 600
      });
      expect(context.session).toMatchObject({ run_state: "open", status: "unknown" });
      expect(context.policy).toMatchObject({
        budget_remaining: 3,
        project_budget_remaining: 5,
        rate_limit_wait_policy: "respect_retry_after"
      });
      expect(context.candidates).toContainEqual(expect.objectContaining({
        diagnosis_code: "provider_retry_after_waiting",
        wait_until: "2026-06-10T08:10:00Z"
      }));
    } finally {
      db.close();
    }
  });

  test("uses policy cooldown for 429 without retry-after and never emits immediate resume candidate", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-rate-limit-no-window-"));
      insertIssue(db, { id: 304, projectID: "runner", title: "Rate limited without window", status: "in_progress", updatedAt: "2026-06-10T07:55:00Z" });
      insertRun(db, { issueID: 304, id: "issue-304-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-304", turnID: "turn-304" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry_after", "session.resume_followup"],
        project_id: "runner",
        supervisor_cooldown_seconds: 900
      });
      insertEvent(db, { issueID: 304, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: { status_code: 429, error: "too many requests" }
      }, createdAt: "2026-06-10T08:00:00Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 304, { now: NOW });

      expect(context.provider_error).toMatchObject({
        category: "rate_limit",
        diagnosis_code: "provider_rate_limited",
        status_code: 429
      });
      expect(context.provider_error?.retry_after_at).toBeUndefined();
      expect(context.candidates).toEqual([expect.objectContaining({
        diagnosis_code: "provider_rate_limited",
        wait_until: "2026-06-10T08:15:00Z"
      })]);
    } finally {
      db.close();
    }
  });

  test("classifies 401 and test failures as requires_human_decision without recovery budget spend", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-human-only-"));
      insertIssue(db, { id: 305, projectID: "runner", title: "Auth failed", status: "in_progress", updatedAt: "2026-06-10T07:55:00Z" });
      insertRun(db, { issueID: 305, id: "issue-305-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-305", turnID: "turn-305" });
      insertEvent(db, { issueID: 305, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: "API returned 401 unauthorized"
      }, createdAt: "2026-06-10T07:59:00Z" });
      insertIssue(db, { id: 306, projectID: "runner", title: "Test failed", status: "in_progress", updatedAt: "2026-06-10T07:55:00Z" });
      insertRun(db, { issueID: 306, id: "issue-306-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-306", turnID: "turn-306" });
      insertEvent(db, { issueID: 306, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: "focused test failed: expected status 200"
      }, createdAt: "2026-06-10T07:59:00Z" });

      const authContext = buildIssueSupervisorRecoveryContext(db, 305, { now: NOW });
      const testContext = buildIssueSupervisorRecoveryContext(db, 306, { now: NOW });

      expect(authContext.provider_error).toMatchObject({ category: "auth", diagnosis_code: "requires_human_decision" });
      expect(testContext.provider_error).toMatchObject({ category: "business_failure", diagnosis_code: "requires_human_decision" });
      expect(authContext.candidates).toEqual([expect.objectContaining({ diagnosis_code: "requires_human_decision" })]);
      expect(testContext.candidates).toEqual([expect.objectContaining({ diagnosis_code: "requires_human_decision" })]);
      expect(authContext.recovery_history).toMatchObject({ attempts_24h: 0, budget_remaining: 3 });
      expect(testContext.recovery_history).toMatchObject({ attempts_24h: 0, budget_remaining: 3 });
    } finally {
      db.close();
    }
  });

  test("marks exhausted candidate after two recoveries without meaningful progress", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-exhausted-"));
      insertIssue(db, { id: 302, projectID: "runner", title: "No progress issue", status: "in_progress", updatedAt: "2026-06-10T07:30:00Z" });
      insertRun(db, { issueID: 302, id: "issue-302-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-302", turnID: "turn-302" });
      for (const actionID of ["resume-1", "resume-2"]) {
        createIssueSupervisorEvent(db, {
          action_id: actionID,
          action_type: "session.resume_followup",
          event_type: "action",
          issue_id: 302,
          project_id: "runner"
        });
        createIssueSupervisorEvent(db, {
          action_id: actionID,
          event_type: "result",
          issue_id: 302,
          payload_json: { outcome: "no_progress" },
          project_id: "runner"
        });
      }
      db.sqlite.run("update issue_supervisor_events set created_at='2026-06-10T07:45:00Z' where issue_id=302");

      const context = buildIssueSupervisorRecoveryContext(db, 302, { now: NOW });

      expect(context.recovery_history).toMatchObject({
        attempts_24h: 0,
        budget_remaining: 3,
        consecutive_no_progress: 2,
        last_outcome: "no_progress"
      });
      expect(context.candidates).toContainEqual(expect.objectContaining({
        diagnosis_code: "session_recovery_exhausted",
        exhausted: true
      }));
    } finally {
      db.close();
    }
  });

  test("reads automatic recovery budget from pi_recovery_attempts instead of attempt_count", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-recovery-budget-"));
      insertIssue(db, { id: 307, projectID: "runner", title: "Budget issue", status: "in_progress", updatedAt: "2026-06-10T07:30:00Z" });
      db.sqlite.run("update issues set attempt_count=99 where id=307");
      insertRun(db, { issueID: 307, id: "issue-307-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-307", turnID: "turn-307" });
      for (const index of [1, 2, 3]) {
        recordPiRecoveryAttempt(db, {
          action_type: "issue.retry",
          budget_window_started_at: "2026-06-10T00:00:00Z",
          created_at: `2026-06-10T07:4${index}:00Z`,
          diagnosis_code: "provider_timeout",
          id: `budget-${index}`,
          idempotency_key: `budget-${index}`,
          issue_id: 307,
          project_id: "runner",
          session_id: "codex:thread-307",
          status: "failed",
          updated_at: `2026-06-10T07:4${index}:00Z`
        });
      }

      const context = buildIssueSupervisorRecoveryContext(db, 307, { now: NOW });

      expect(context.issue).toMatchObject({ attempt_count: 99 });
      expect(context.recovery_history).toMatchObject({
        attempts_24h: 3,
        budget_remaining: 0,
        budget_status: "issue_budget_exhausted"
      });
      expect(context.candidates).toContainEqual(expect.objectContaining({
        diagnosis_code: "recovery_budget_exhausted",
        exhausted: true
      }));
    } finally {
      db.close();
    }
  });

  test("classifies active, ended, and unknown session/run states from agent_sessions and issue_runs", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-session-states-"));
      insertIssue(db, { id: 401, projectID: "runner", title: "Active issue", status: "in_progress", updatedAt: "2026-06-10T07:59:00Z" });
      insertRun(db, { issueID: 401, id: "issue-401-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-401", turnID: "turn-401" });
      insertSession(db, { issueID: 401, projectID: "runner", sessionID: "thread-401", status: "running", updatedAt: "2026-06-10T07:59:00Z" });
      insertIssue(db, { id: 402, projectID: "runner", title: "Ended issue", status: "done", updatedAt: "2026-06-10T07:00:00Z" });
      insertRun(db, { issueID: 402, id: "issue-402-attempt-1", status: "done", endedAt: "2026-06-10T07:00:00Z", sessionID: "thread-402", turnID: "turn-402" });
      insertIssue(db, { id: 403, projectID: "runner", title: "Unknown issue", status: "in_progress", updatedAt: "2026-06-10T07:59:00Z" });

      expect(buildIssueSupervisorRecoveryContext(db, 401, { now: NOW }).session).toMatchObject({
        run_state: "open",
        status: "active"
      });
      expect(buildIssueSupervisorRecoveryContext(db, 402, { now: NOW }).session).toMatchObject({
        run_state: "ended",
        status: "ended"
      });
      expect(buildIssueSupervisorRecoveryContext(db, 403, { now: NOW }).session).toMatchObject({
        run_state: "unknown",
        status: "unknown"
      });
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-context-db-");
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`, [id, id, cwd, "2026-06-10T01:00:00Z", "2026-06-10T01:00:00Z"]);
}

function insertIssue(db: RunnerDatabase, input: {
  id: number;
  projectID: string;
  status: string;
  title: string;
  updatedAt: string;
}): void {
  db.sqlite.run(`insert into issues
    (id, project_id, title, description, status, attempt_count, created_at, updated_at)
    values (?, ?, ?, ?, ?, 1, ?, ?)`,
    [input.id, input.projectID, input.title, input.title, input.status, "2026-06-10T01:00:00Z", input.updatedAt]);
}

function insertRun(db: RunnerDatabase, input: {
  endedAt: string;
  id: string;
  issueID: number;
  sessionID: string;
  status: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, ?, 'codex', ?, ?, '2026-06-10T01:50:00Z', ?)`,
    [input.id, input.issueID, input.status, input.sessionID, input.turnID, input.endedAt]);
}

function insertSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionID: string;
  status: string;
  updatedAt: string;
}): void {
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, ?, '{}', ?, ?)`,
    [`codex:${input.sessionID}`, input.sessionID, input.projectID, input.issueID, input.status, "2026-06-10T01:55:00Z", input.updatedAt]);
}

function insertEvent(db: RunnerDatabase, input: {
  createdAt: string;
  issueID: number;
  payload: unknown;
  type: string;
}): void {
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [input.issueID, input.type, JSON.stringify(input.payload), input.createdAt]);
}
