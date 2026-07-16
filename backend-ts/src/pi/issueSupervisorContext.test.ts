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

  test("does not escalate an active Codex turn for an intermediate failed command", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-active-command-failed-"));
      insertIssue(db, { id: 556, projectID: "runner", title: "Verification evidence", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 556, id: "issue-556-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-556", turnID: "turn-556" });
      insertSession(db, { issueID: 556, projectID: "runner", sessionID: "thread-556", status: "running", updatedAt: "2026-06-10T07:59:45Z" });
      insertEvent(db, { issueID: 556, type: "issue.log", payload: {
        command: "/bin/zsh -lc \"cd backend-ts && bun test src/pi/verificationEvidence.test.ts\"",
        provider: "codex",
        raw_method: "item/completed",
        status: "failed",
        text: "! command failed: /bin/zsh -lc \"cd backend-ts && bun test src/pi/verificationEvidence.test.ts\"",
        type: "tool"
      }, createdAt: "2026-06-10T07:59:40Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 556, { now: NOW });

      expect(context.session).toMatchObject({ run_state: "open", status: "active" });
      expect(context.provider_error).toBeNull();
      expect(context.candidates).toEqual([]);
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

  test("treats an idle session with an open issue run as an immediate recovery candidate", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-idle-session-"));
      insertIssue(db, { id: 404, projectID: "runner", title: "Idle issue", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 404, id: "issue-404-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-404", turnID: "turn-404" });
      insertSession(db, { issueID: 404, projectID: "runner", sessionID: "thread-404", status: "idle", updatedAt: "2026-06-10T07:59:30Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 404, { now: NOW, staleAfterSeconds: 300 });

      expect(context.session).toMatchObject({ raw_status: "idle", status: "idle", stale_gap_seconds: 30 });
      expect(context.candidates).toContainEqual(expect.objectContaining({
        diagnosis_code: "session_no_recent_progress",
        reason: "session is idle while issue run remains open"
      }));
    } finally {
      db.close();
    }
  });

  test("surfaces deferred provider infra failures as PI recovery candidates", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-deferred-provider-"));
      insertIssue(db, { id: 405, projectID: "runner", title: "Deferred provider", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 405, id: "issue-405-attempt-1", status: "in_progress", endedAt: "", provider: "claude", sessionID: "thread-405", turnID: "turn-405" });
      insertSession(db, { issueID: 405, projectID: "runner", provider: "claude", sessionID: "thread-405", status: "running", updatedAt: "2026-06-10T07:59:30Z" });
      insertEvent(db, { issueID: 405, type: "issue.provider_deferred", payload: {
        error: "Claude Code run timed out after 10000ms",
        provider: "claude",
        reason: "provider_infra_transient"
      }, createdAt: "2026-06-10T07:59:45Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 405, { now: NOW });

      expect(context.provider_error).toMatchObject({
        category: "network",
        diagnosis_code: "provider_transient_network_error",
        provider: "claude",
        raw_summary: "Claude Code run timed out after 10000ms"
      });
      expect(context.candidates).toContainEqual(expect.objectContaining({
        diagnosis_code: "provider_transient_network_error",
        evidence_refs: ["provider_error"]
      }));
    } finally {
      db.close();
    }
  });

  test("keeps the first thread/start timeout without a session recoverable", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-runtime-outage-"));
      insertIssue(db, { id: 406, projectID: "runner", title: "Initialize timeout", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 406, id: "issue-406-attempt-1", status: "in_progress", endedAt: "", sessionID: "", turnID: "" });
      insertEvent(db, { issueID: 406, type: "issue.provider_deferred", payload: {
        error: "codex thread/start failed: codex app-server request timed out after 90000ms: thread/start cwd=/Users/xiaobei/private token=sk-live-secret",
        provider: "codex",
        reason: "provider_infra_transient"
      }, createdAt: "2026-06-10T07:59:45Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 406, { now: NOW });

      expect(context.provider_error).toMatchObject({
        category: "network",
        diagnosis_code: "provider_transient_network_error"
      });
      expect(context.session).toMatchObject({ provider_session_id: "", status: "unknown" });
      expect(context.candidates[0]).toMatchObject({
        diagnosis_code: "provider_transient_network_error",
        evidence_refs: ["provider_error"]
      });
      expect(context.candidates.map((item) => item.diagnosis_code)).not.toContain("provider_runtime_unavailable");
      const serialized = JSON.stringify(context.candidates);
      expect(serialized).not.toContain("sk-live-secret");
      expect(serialized).not.toContain("/Users/xiaobei/private");
    } finally {
      db.close();
    }
  });

  test("ignores provider failures from a closed attempt while a new attempt is starting", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-new-attempt-"));
      insertIssue(db, { id: 411, projectID: "runner", title: "Fresh attempt", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, {
        issueID: 411,
        id: "issue-411-attempt-1",
        attempt: 1,
        status: "failed",
        endedAt: "2026-06-10T07:52:00Z",
        sessionID: "",
        turnID: "",
        startedAt: "2026-06-10T07:50:00Z"
      });
      insertEvent(db, { issueID: 411, type: "issue.provider_deferred", payload: {
        error: "app-server request timed out after 10000ms: initialize",
        provider: "codex",
        reason: "provider_infra_transient"
      }, createdAt: "2026-06-10T07:51:00Z" });
      insertRun(db, {
        issueID: 411,
        id: "issue-411-attempt-2",
        attempt: 2,
        status: "in_progress",
        endedAt: "",
        sessionID: "",
        turnID: "",
        startedAt: "2026-06-10T07:59:30Z"
      });

      const context = buildIssueSupervisorRecoveryContext(db, 411, { now: NOW });

      expect(context.provider_error).toBeNull();
      expect(context.candidates.map((item) => item.diagnosis_code)).not.toContain("provider_runtime_unavailable");
      expect(context.latest_run).toMatchObject({ id: "issue-411-attempt-2", status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("keeps a single transient stream disconnect recoverable when session exists", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-recoverable-transient-"));
      insertIssue(db, { id: 407, projectID: "runner", title: "Recoverable transient", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 407, id: "issue-407-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-407", turnID: "turn-407" });
      insertSession(db, { issueID: 407, projectID: "runner", sessionID: "thread-407", status: "running", updatedAt: "2026-06-10T07:59:30Z" });
      insertEvent(db, { issueID: 407, type: "issue.log", payload: {
        type: "error",
        provider: "codex",
        raw_payload: "stream disconnected before completion"
      }, createdAt: "2026-06-10T07:59:45Z" });

      const context = buildIssueSupervisorRecoveryContext(db, 407, { now: NOW });

      expect(context.provider_error).toMatchObject({ diagnosis_code: "executor_stream_disconnected" });
      expect(context.candidates.map((item) => item.diagnosis_code)).toContain("executor_stream_disconnected");
      expect(context.candidates.map((item) => item.diagnosis_code)).not.toContain("provider_runtime_unavailable");
    } finally {
      db.close();
    }
  });

  test("promotes repeated deferred events on the same issue to provider runtime unavailable", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-repeated-deferred-"));
      insertIssue(db, { id: 410, projectID: "runner", title: "Repeated deferrals", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
      insertRun(db, { issueID: 410, id: "issue-410-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-410", turnID: "turn-410" });
      insertSession(db, { issueID: 410, projectID: "runner", sessionID: "thread-410", status: "running", updatedAt: "2026-06-10T07:59:30Z" });
      for (const [index, type] of ["issue.provider_deferred", "issue.recovery_deferred"].entries()) {
        insertEvent(db, { issueID: 410, type, payload: {
          error: "app-server request timed out after 10000ms: initialize",
          provider: "codex",
          reason: "provider_infra_transient"
        }, createdAt: `2026-06-10T07:59:4${index}Z` });
      }

      const context = buildIssueSupervisorRecoveryContext(db, 410, { now: NOW });

      expect(context.candidates[0]).toMatchObject({
        diagnosis_code: "provider_runtime_unavailable",
        evidence_refs: expect.arrayContaining(["provider_error", "recent_events"])
      });
    } finally {
      db.close();
    }
  });

  test("promotes same project/provider deferred failures to provider runtime unavailable", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "runner", await tempRoot("runner-provider-outage-"));
      for (const id of [408, 409]) {
        insertIssue(db, { id, projectID: "runner", title: `Deferred provider ${id}`, status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
        insertRun(db, { issueID: id, id: `issue-${id}-attempt-1`, status: "in_progress", endedAt: "", provider: "claude", sessionID: `thread-${id}`, turnID: `turn-${id}` });
        insertSession(db, { issueID: id, projectID: "runner", provider: "claude", sessionID: `thread-${id}`, status: "running", updatedAt: "2026-06-10T07:59:30Z" });
        insertEvent(db, { issueID: id, type: "issue.provider_deferred", payload: {
          error: `Claude Code run timed out after 10000ms in /Users/xiaobei/private?token=sk-live-secret-${id}`,
          provider: "claude",
          reason: "provider_infra_transient"
        }, createdAt: `2026-06-10T07:59:4${id - 408}Z` });
      }

      const context = buildIssueSupervisorRecoveryContext(db, 408, { now: NOW });

      expect(context.candidates[0]).toMatchObject({
        diagnosis_code: "provider_runtime_unavailable",
        evidence_refs: expect.arrayContaining(["provider_error", "project_provider_deferred_events"])
      });
      const serialized = JSON.stringify(context.candidates);
      expect(serialized).not.toContain("sk-live-secret");
      expect(serialized).not.toContain("/Users/xiaobei/private");
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
  attempt?: number;
  endedAt: string;
  id: string;
  issueID: number;
  provider?: string;
  sessionID: string;
  status: string;
  startedAt?: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.issueID, input.attempt ?? 1, input.status, input.provider ?? "codex", input.sessionID,
      input.turnID, input.startedAt ?? "2026-06-10T01:50:00Z", input.endedAt]);
}

function insertSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  provider?: string;
  sessionID: string;
  status: string;
  updatedAt: string;
}): void {
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    [`${input.provider ?? "codex"}:${input.sessionID}`, input.provider ?? "codex", input.sessionID, input.projectID, input.issueID, input.status, "2026-06-10T01:55:00Z", input.updatedAt]);
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
