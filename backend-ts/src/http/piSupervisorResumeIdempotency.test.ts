import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts, recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI supervisor resume follow-up idempotency", () => {
  test("records executing attempt before provider call and saves result turn", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 315);
      provider.onSend = () => expect(attempts(db, 315)).toContainEqual(expect.objectContaining({
        expected_provider_turn_id: "turn-old",
        result_provider_turn_id: "",
        status: "executing"
      }));

      await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 315));

      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-315" }]);
      expect(attempts(db, 315)).toContainEqual(expect.objectContaining({
        expected_provider_turn_id: "turn-old",
        result_provider_turn_id: "turn-followup",
        status: "executing"
      }));
      expect(JSON.parse(getAgentSession(db, "codex:thread-315")?.raw_ref ?? "{}"))
        .toMatchObject({ provider_turn_id: "turn-followup" });
      expect(listIssueRuns(db, 315).at(-1)).toMatchObject({ provider_turn_id: "turn-followup" });
      expect(listIssueEvents(db, 315).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
    } finally {
      db.close();
    }
  });

  test("does not resend while matching executing attempt is under hard timeout", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 316);
      recordPiRecoveryAttempt(db, resumeAttempt(316, "2999-01-01T00:00:00Z"));

      const result = await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 316));

      expect(provider.calls).toEqual([]);
      expect(result).toMatchObject({ outcome: "attempt_executing", skipped: true });
      expect(attempts(db, 316)).toHaveLength(1);
    } finally {
      db.close();
    }
  });


  test("held executing attempt suppresses provider call even if current action already has an attempt", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 320);
      recordPiRecoveryAttempt(db, resumeAttempt(320, "2999-01-01T00:00:00Z", "previous"));
      recordPiRecoveryAttempt(db, {
        ...resumeAttempt(320, "2999-01-01T00:05:00Z", "current"),
        id: "recovery-resume-action-320",
        source_decision_id: "resume-action-320"
      });

      const result = await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 320));

      expect(provider.calls).toEqual([]);
      expect(result).toMatchObject({ outcome: "attempt_executing", skipped: true });
    } finally {
      db.close();
    }
  });

  test("observed provider progress after crash is recorded instead of resending", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 317);
      provider.readTurnID = "turn-already-started";
      recordPiRecoveryAttempt(db, resumeAttempt(317, "2026-06-10T07:05:00Z"));

      const result = await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 317));

      expect(provider.calls).toEqual([]);
      expect(result).toMatchObject({ outcome: "progress", provider_turn_id: "turn-already-started", skipped: true });
      expect(attempts(db, 317)[0]).toMatchObject({ result_provider_turn_id: "turn-already-started", status: "progress" });
      expect(listIssueRuns(db, 317).at(-1)).toMatchObject({ provider_turn_id: "turn-already-started" });
    } finally {
      db.close();
    }
  });



  test("local persisted turn progress is recorded before stale turn precondition can resend", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 319);
      recordPiRecoveryAttempt(db, resumeAttempt(319, "2026-06-10T07:05:00Z"));
      db.sqlite.run("update issue_runs set provider_turn_id=? where issue_id=?", ["turn-persisted", 319]);
      db.sqlite.run("update agent_sessions set raw_ref=? where session_key=?", [
        JSON.stringify({ provider_turn_id: "turn-persisted" }), "codex:thread-319"
      ]);

      const result = await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 319));

      expect(provider.calls).toEqual([]);
      expect(result).toMatchObject({ outcome: "progress", provider_turn_id: "turn-persisted", skipped: true });
      expect(attempts(db, 319)[0]).toMatchObject({ result_provider_turn_id: "turn-persisted", status: "progress" });
    } finally {
      db.close();
    }
  });

  test("retries only after hard timeout when provider turn did not advance", async () => {
    const db = await fixtureDb();
    const provider = new ResumeProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, 318);
      provider.readTurnID = "turn-old";
      recordPiRecoveryAttempt(db, resumeAttempt(318, "2026-06-10T07:05:00Z"));

      await dispatchPiAction({ database: db, providers: { codex: provider } }, resumeAction(db, 318));

      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-318" }]);
      expect(attempts(db, 318)).toContainEqual(expect.objectContaining({
        id: "recovery-resume-action-318",
        result_provider_turn_id: "turn-followup",
        status: "executing"
      }));
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-resume-idempotency-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function attempts(db: RunnerDatabase, issueID: number) {
  return listPiRecoveryAttempts(db, { issueId: issueID });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 0, ?, ?)`, [id, id, `/tmp/${id}`, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssueRunSession(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, 'demo', 'Supervisor issue', 'in_progress', ?, ?)`, [issueID, "2026-06-10T06:00:00Z", "2026-06-10T07:00:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, 'turn-old', ?, '')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, "2026-06-10T06:30:00Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, 'demo', ?, 'running', ?, ?, ?)`,
  [`codex:thread-${issueID}`, `thread-${issueID}`, issueID, JSON.stringify({ provider_turn_id: "turn-old" }),
    "2026-06-10T06:30:00Z", "2026-06-10T07:01:00Z"]);
}

function resumeAction(db: RunnerDatabase, issueID: number) {
  return createPiAction(db, {
    action_type: "session.resume_followup",
    id: `resume-action-${issueID}`,
    issue_id: issueID,
    payload_json: JSON.stringify({
      expected_issue_updated_at: "2026-06-10T07:00:00Z",
      expected_provider_turn_id: "turn-old",
      expected_run_id: `issue-${issueID}-attempt-1`,
      expected_session_updated_at: "2026-06-10T07:01:00Z",
      issue_id: issueID,
      prompt: "Inspect current state and continue safely.",
      provider: "codex",
      provider_session_id: `thread-${issueID}`
    }),
    project_id: "demo",
    status: "approved"
  });
}

function resumeAttempt(issueID: number, hardTimeoutAt: string, suffix = "existing") {
  return {
    action_type: "session.resume_followup",
    budget_window_started_at: "2026-06-10T07:00:00Z",
    created_at: "2026-06-10T07:00:00Z",
    diagnosis_code: "provider_timeout",
    executing_started_at: "2026-06-10T07:00:00Z",
    expected_provider_turn_id: "turn-old",
    hard_timeout_at: hardTimeoutAt,
    id: `resume-attempt-${issueID}-${suffix}`,
    idempotency_key: `resume:thread-${issueID}:turn-old:guardian:${suffix}`,
    issue_id: issueID,
    project_id: "demo",
    provider_session_id: `thread-${issueID}`,
    provider_turn_id: "turn-old",
    session_id: `codex:thread-${issueID}`,
    status: "executing" as const,
    updated_at: "2026-06-10T07:00:00Z"
  };
}

class ResumeProvider implements ExecutorProvider {
  onSend?: () => void;
  readTurnID = "";
  readonly calls: Record<string, unknown>[] = [];
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    return { runId: `codex-run-${input.issueId}` };
  }

  async readSession(sessionId: string) {
    return {
      id: `codex:${sessionId}`,
      provider: "codex" as const,
      provider_session_id: sessionId,
      sessionId,
      ...(this.readTurnID === "" ? {} : { provider_turn_id: this.readTurnID, turn_id: this.readTurnID })
    };
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt, sessionId: input.sessionId });
    this.onSend?.();
    return {
      provider: "codex" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-followup"
    };
  }
}
