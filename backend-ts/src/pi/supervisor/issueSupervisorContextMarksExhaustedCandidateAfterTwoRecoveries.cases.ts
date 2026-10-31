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

export function registerMarksExhaustedCandidateAfterTwoRecoveries() {
test("marks exhausted candidate after two recoveries without meaningful progress", async () => {
    const db = await fixtureDb();
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
      budget_remaining: 6,
      consecutive_no_progress: 2,
      last_outcome: "no_progress"
    });
    expect(context.candidates).toContainEqual(expect.objectContaining({
      diagnosis_code: "session_recovery_exhausted",
      exhausted: true
    }));
  });

test("reads automatic recovery budget from pi_recovery_attempts instead of attempt_count", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-recovery-budget-"));
    insertIssue(db, { id: 307, projectID: "runner", title: "Budget issue", status: "in_progress", updatedAt: "2026-06-10T07:30:00Z" });
    db.sqlite.run("update issues set attempt_count=99 where id=307");
    insertRun(db, { issueID: 307, id: "issue-307-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-307", turnID: "turn-307" });
    for (const index of [1, 2, 3, 4, 5, 6]) {
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
      attempts_24h: 6,
      budget_remaining: 0,
      budget_status: "issue_budget_exhausted"
    });
    expect(context.candidates).toContainEqual(expect.objectContaining({
      diagnosis_code: "recovery_budget_exhausted",
      exhausted: true
    }));
  });

test("treats an idle session with an open issue run as an immediate recovery candidate", async () => {
    const db = await fixtureDb();
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
  });

test("proactively watches a running session after fifteen minutes without updates", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-default-stale-session-"));
    insertIssue(db, { id: 414, projectID: "runner", title: "Stale running issue", status: "in_progress", updatedAt: "2026-06-10T07:44:59Z" });
    insertRun(db, { issueID: 414, id: "issue-414-attempt-1", status: "in_progress", endedAt: "", sessionID: "thread-414", turnID: "turn-414" });
    insertSession(db, { issueID: 414, projectID: "runner", sessionID: "thread-414", status: "running", updatedAt: "2026-06-10T07:44:59Z" });

    const context = buildIssueSupervisorRecoveryContext(db, 414, { now: NOW });

    expect(context.session).toMatchObject({ status: "disconnected", stale_gap_seconds: 901 });
    expect(context.candidates).toContainEqual(expect.objectContaining({
      diagnosis_code: "session_no_recent_progress",
      reason: "session has no recent updates"
    }));
  });

test("does not resume an idle session after its run has already ended", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-ended-idle-session-"));
    insertIssue(db, { id: 415, projectID: "runner", title: "Ended idle issue", status: "in_progress", updatedAt: "2026-06-10T07:30:00Z" });
    insertRun(db, { issueID: 415, id: "issue-415-attempt-1", status: "failed", endedAt: "2026-06-10T07:40:00Z", sessionID: "thread-415", turnID: "turn-415" });
    insertSession(db, { issueID: 415, projectID: "runner", sessionID: "thread-415", status: "idle", updatedAt: "2026-06-10T07:40:00Z" });

    const context = buildIssueSupervisorRecoveryContext(db, 415, { now: NOW });

    expect(context.candidates).not.toContainEqual(expect.objectContaining({
      diagnosis_code: "session_no_recent_progress"
    }));
  });

test("escalates a deterministic failed executor attempt instead of blindly retrying", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-failed-attempt-"));
    insertIssue(db, { id: 416, projectID: "runner", title: "Failed attempt", status: "failed", updatedAt: "2026-06-10T07:50:00Z" });
    insertRun(db, { issueID: 416, id: "issue-416-attempt-1", status: "failed", endedAt: "2026-06-10T07:50:00Z", sessionID: "thread-416", turnID: "turn-416" });
    insertSession(db, { issueID: 416, projectID: "runner", sessionID: "thread-416", status: "failed", updatedAt: "2026-06-10T07:50:00Z" });
    insertEvent(db, { issueID: 416, type: "issue.log", payload: {
      type: "error",
      provider: "codex",
      raw_payload: "focused test failed: expected status 200"
    }, createdAt: "2026-06-10T07:49:59Z" });

    const context = buildIssueSupervisorRecoveryContext(db, 416, { now: NOW });

    expect(context.provider_error).toMatchObject({ category: "business_failure" });
    expect(context.candidates).toEqual([expect.objectContaining({
      diagnosis_code: "requires_human_decision"
    })]);
  });

test("reopens diagnosis for a failed issue closed by the legacy invalid Supervisor fallback", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", await tempRoot("runner-legacy-invalid-supervisor-"));
    insertIssue(db, {
      id: 417,
      projectID: "runner",
      title: "Legacy false escalation",
      status: "failed",
      updatedAt: "2026-06-10T07:50:00Z"
    });
    insertRun(db, {
      issueID: 417,
      id: "issue-417-attempt-1",
      status: "failed",
      endedAt: "2026-06-10T07:50:00Z",
      sessionID: "thread-417",
      turnID: "turn-417"
    });
    db.sqlite.run("update issues set error=? where id=417", [
      "needs_user: session_no_recent_progress\n" +
      "Xuanwu Supervisor failed to return a valid decision. Check the configured Agent/model/provider and its decision audit before retrying."
    ]);

    const context = buildIssueSupervisorRecoveryContext(db, 417, { now: NOW });

    expect(context.provider_error).toBeNull();
    expect(context.candidates).toEqual([expect.objectContaining({
      diagnosis_code: "session_no_recent_progress",
      evidence_refs: ["issue", "supervisor_decision_failed"]
    })]);
  });

test("surfaces deferred provider infra failures as PI recovery candidates", async () => {
    const db = await fixtureDb();
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
  });
}
