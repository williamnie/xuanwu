import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueSupervisorEvent, upsertProjectPiPolicy } from "../../db/repositories/pi.ts";
import { recordPiRecoveryAttempt } from "../../db/repositories/pi/recoveryAttempts.ts";
import { buildIssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { latestProviderError } from "./issueSupervisorContextSupport.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, NOW, tempRoots, fixtureDb, tempRoot, insertProject, insertIssue, insertRun, insertSession, insertEvent } from "./issueSupervisorContextTestFixtures.ts";

export function registerScheduledWaitsDoNotInventRate() {
test("scheduled waits do not invent rate limits and a resumed turn clears old provider errors", () => {
    const wait = { id: 1, issue_id: 967, type: "issue.retry_after_scheduled", created_at: "2026-06-10T07:00:00Z",
      payload: JSON.stringify({ reason: "session_no_recent_progress", retry_after_at: "2026-06-10T07:05:00Z" }) };
    expect(latestProviderError([wait], NOW)).toBeNull();
    const error = { ...wait, type: "issue.log", payload: JSON.stringify({ type: "error", raw_payload: { status_code: 429, retry_after: 600 } }) };
    expect(latestProviderError([error, wait], NOW)?.category).toBe("rate_limit");
    expect(latestProviderError([error, wait, { ...wait, type: "issue.supervisor_resume_followup" }], NOW)).toBeNull();
  });

test("builds #298 disconnect context with last error, open run, session id, and 6h stale gap", async () => {
    const db = await fixtureDb();
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
      command: "bun test backend-ts/src/pi/supervisor/issueSupervisorContext.test.ts",
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
    expect(context.candidates.map((item) => item.diagnosis_code)).not.toContain("session_no_recent_progress");
    expect(context.workspace_snapshot).toMatchObject({
      last_agent_message: "I inspected the current state and found the narrow failing path.",
      last_commands: ["bun test backend-ts/src/pi/supervisor/issueSupervisorContext.test.ts"]
    });
    expect(context.recent_events.flatMap((event) => event.markers)).toEqual(expect.arrayContaining([
      "agent_message",
      "tool_command",
      "verification"
    ]));
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("/Users/xiaobei/private");
  });

test("shows 429 wait window and recovery budget", async () => {
    const db = await fixtureDb();
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
      project_budget_unlimited: true,
      rate_limit_wait_policy: "respect_retry_after"
    });
    expect(context.candidates).toContainEqual(expect.objectContaining({
      diagnosis_code: "provider_retry_after_waiting",
      wait_until: "2026-06-10T08:10:00Z"
    }));
  });

test("uses policy cooldown for 429 without retry-after and never emits immediate resume candidate", async () => {
    const db = await fixtureDb();
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
  });

test("classifies 401 and test failures as requires_human_decision without recovery budget spend", async () => {
    const db = await fixtureDb();
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
    expect(authContext.recovery_history).toMatchObject({ attempts_24h: 0, budget_remaining: 6 });
    expect(testContext.recovery_history).toMatchObject({ attempts_24h: 0, budget_remaining: 6 });
  });

test("does not escalate an active Codex turn for an intermediate failed command", async () => {
    const db = await fixtureDb();
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
  });
}
