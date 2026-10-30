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

export function registerKeepsTheFirstThreadStartTimeout() {
test("keeps the first thread/start timeout without a session recoverable", async () => {
    const db = await fixtureDb();
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
  });

test("ignores provider failures from a closed attempt while a new attempt is starting", async () => {
    const db = await fixtureDb();
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
  });

test("keeps a single transient stream disconnect recoverable when session exists", async () => {
    const db = await fixtureDb();
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
  });

test("does not double-count provider and lifecycle annotations for one deferred failure", async () => {
    const db = await fixtureDb();
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

    expect(context.candidates.map((item) => item.diagnosis_code))
      .not.toContain("provider_runtime_unavailable");
    expect(context.candidates.map((item) => item.diagnosis_code))
      .toContain("provider_transient_network_error");
  });

test("promotes two distinct provider deferrals on the same issue to runtime unavailable", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-repeated-provider-deferred-"));
    insertIssue(db, { id: 412, projectID: "runner", title: "Repeated provider deferrals", status: "in_progress", updatedAt: "2026-06-10T07:59:30Z" });
    insertRun(db, { issueID: 412, id: "issue-412-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-412", turnID: "turn-412" });
    insertSession(db, { issueID: 412, projectID: "runner", sessionID: "thread-412", status: "running", updatedAt: "2026-06-10T07:59:30Z" });
    for (const [index, createdAt] of ["2026-06-10T07:59:40Z", "2026-06-10T07:59:50Z"].entries()) {
      insertEvent(db, { issueID: 412, type: "issue.provider_deferred", payload: {
        backoff_attempt: index + 1,
        error: "app-server request timed out after 10000ms: initialize",
        provider: "codex",
        reason: "provider_infra_transient"
      }, createdAt });
    }

    const context = buildIssueSupervisorRecoveryContext(db, 412, { now: NOW });

    expect(context.candidates[0]).toMatchObject({
      diagnosis_code: "provider_runtime_unavailable",
      evidence_refs: expect.arrayContaining(["provider_error", "recent_events"])
    });
  });

test("promotes same project/provider deferred failures to provider runtime unavailable", async () => {
    const db = await fixtureDb();
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
  });

test("classifies active, ended, and unknown session/run states from agent_sessions and issue_runs", async () => {
    const db = await fixtureDb();
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
  });
}
