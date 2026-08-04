import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordPiRecoveryAttempt, getPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { createIssueSupervisorEvent, listIssueSupervisorEvents } from "../db/repositories/pi.ts";
import { buildIssueSupervisorRecoveryContext } from "../pi/issueSupervisorContext.ts";
import { refreshSupervisorProgressResult } from "./issueSupervisorProgressTracker.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("issue supervisor progress tracker", () => {
  test("updates recovery attempt as no_progress for keepalive/token/repeated-error only activity", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertRunningIssue(db, 701, "demo", "thread-701", "turn-old");
      recordAction(db, 701, "resume-action-701", "2026-06-10T07:00:00Z");
      recordPiRecoveryAttempt(db, attemptInput(701, "attempt-701", "resume-action-701", beforeSnapshot()));
      insertIssueLog(db, 701, { type: "keepalive", text: "keepalive" }, "2026-06-10T07:01:00Z");
      insertIssueLog(db, 701, { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 12 } } } }, "2026-06-10T07:02:00Z");
      insertIssueLog(db, 701, { type: "error", error: "HTTP 429: too many requests" }, "2026-06-10T07:03:00Z");
      insertIssueLog(db, 701, { type: "error", error: "HTTP 429: too many requests" }, "2026-06-10T07:04:00Z");
      insertIssueLog(db, 701, { timestamp: "2026-06-10T07:05:00Z" }, "2026-06-10T07:05:00Z");

      const outcome = refreshSupervisorProgressResult({
        context: buildIssueSupervisorRecoveryContext(db, 701, { now: new Date("2026-06-10T07:06:30Z") }),
        database: db,
        issueID: 701,
        now: new Date("2026-06-10T07:06:30Z"),
        projectID: "demo",
        staleAfterSeconds: 60
      });

      expect(outcome).toBe("no_progress");
      expect(getPiRecoveryAttempt(db, "attempt-701")).toMatchObject({
        progress_detected: 0,
        status: "no_progress"
      });
      expect(JSON.parse(getPiRecoveryAttempt(db, "attempt-701")?.after_snapshot_json ?? "{}")).toMatchObject({
        issue: { status: "in_progress" },
        session: { status: "running" }
      });
      const resultPayload = JSON.parse(listIssueSupervisorEvents(db, { issueId: 701 }).at(-1)?.payload_json ?? "{}");
      expect(resultPayload).toMatchObject({ outcome: "no_progress", recovery_attempt_id: "attempt-701" });
      expect(resultPayload.ignored_reasons).toEqual(expect.arrayContaining([
        "keepalive", "repeated_error", "timestamp_only", "token_usage"
      ]));
    } finally {
      db.close();
    }
  });

  test("compares before and after snapshots and marks status progress", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertRunningIssue(db, 702, "demo", "thread-702", "turn-old");
      recordAction(db, 702, "resume-action-702", "2026-06-10T07:00:00Z");
      recordPiRecoveryAttempt(db, attemptInput(702, "attempt-702", "resume-action-702", beforeSnapshot()));
      db.sqlite.run("update issues set status='pending_verification', updated_at='2026-06-10T07:02:00Z' where id=702");

      const outcome = refreshSupervisorProgressResult({
        context: buildIssueSupervisorRecoveryContext(db, 702, { now: new Date("2026-06-10T07:06:30Z") }),
        database: db,
        issueID: 702,
        now: new Date("2026-06-10T07:06:30Z"),
        projectID: "demo",
        staleAfterSeconds: 60
      });

      expect(outcome).toBe("progress");
      expect(getPiRecoveryAttempt(db, "attempt-702")).toMatchObject({
        progress_detected: 1,
        status: "progress"
      });
      expect(JSON.parse(getPiRecoveryAttempt(db, "attempt-702")?.progress_reasons_json ?? "[]"))
        .toContain("issue_status_updated");
      expect(JSON.parse(getPiRecoveryAttempt(db, "attempt-702")?.after_snapshot_json ?? "{}")).toMatchObject({
        issue: { status: "pending_verification" }
      });
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-progress-tracker-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`,
  [id, id, join(tmpdir(), `xuanwu-progress-${id}`), "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertRunningIssue(db: RunnerDatabase, issueID: number, projectID: string, sessionID: string, turnID: string): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`,
  [issueID, projectID, "2026-06-10T06:00:00Z", "2026-06-10T07:00:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, ?, '')`,
  [`issue-${issueID}-attempt-1`, issueID, sessionID, turnID, "2026-06-10T06:30:00Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, ?, ?)`,
  [`codex:${sessionID}`, sessionID, projectID, issueID,
    JSON.stringify({ provider_turn_id: turnID }), "2026-06-10T06:30:00Z", "2026-06-10T07:00:00Z"]);
}

function recordAction(db: RunnerDatabase, issueID: number, actionID: string, createdAt: string): void {
  createIssueSupervisorEvent(db, {
    action_id: actionID,
    action_type: "session.resume_followup",
    decision: "resume_session",
    diagnosis_code: "stream_disconnect",
    event_type: "action",
    issue_id: issueID,
    payload_json: { action_id: actionID },
    project_id: "demo"
  });
  db.sqlite.run("update issue_supervisor_events set created_at=? where action_id=? and event_type='action'", [createdAt, actionID]);
}

function insertIssueLog(db: RunnerDatabase, issueID: number, payload: unknown, createdAt: string): void {
  db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)", [
    issueID,
    JSON.stringify(payload),
    createdAt
  ]);
}

function attemptInput(issueID: number, id: string, actionID: string, snapshot: unknown) {
  return {
    action_type: "session.resume_followup",
    before_snapshot_json: snapshot,
    budget_window_started_at: "2026-06-10T07:00:00Z",
    created_at: "2026-06-10T07:00:00Z",
    diagnosis_code: "stream_disconnect",
    id,
    idempotency_key: `resume:thread-${issueID}:turn-old:${actionID}`,
    issue_id: issueID,
    project_id: "demo",
    session_id: `codex:thread-${issueID}`,
    status: "executing" as const,
    updated_at: "2026-06-10T07:00:00Z"
  };
}

function beforeSnapshot() {
  return {
    git_diff_hash: "",
    issue: { status: "in_progress", updated_at: "2026-06-10T07:00:00Z" },
    run: { status: "in_progress", updated_at: "2026-06-10T06:30:00Z" },
    session: { status: "running", updated_at: "2026-06-10T07:00:00Z" }
  };
}
