import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI action dispatcher supervisor actions", () => {
  test("session.resume_followup sends a new session message and updates turn refs", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "resume-action",
        issue_id: 305,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-305-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 305,
          prompt: "Inspect current state and continue safely.",
          provider: "codex",
          provider_session_id: "thread-305"
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);

      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-305" }]);
      expect(JSON.parse(getAgentSession(db, "codex:thread-305")?.raw_ref ?? "{}")).toMatchObject({
        provider_turn_id: "turn-followup"
      });
      expect(listIssueRuns(db, 305).at(-1)).toMatchObject({ provider_turn_id: "turn-followup" });
      expect(listIssueEvents(db, 305).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
    } finally {
      db.close();
    }
  });

  test("issue.retry_after records due time without resuming the provider", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 306, projectID: "demo", sessionID: "thread-306", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "issue.retry_after",
        id: "retry-after-action",
        issue_id: 306,
        payload_json: JSON.stringify({
          issue_id: 306,
          reason: "provider_rate_limited",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-306-attempt-1",
          retry_after_at: "2026-06-10T08:10:00Z",
          source_event_id: 7
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);

      expect(provider.calls).toEqual([]);
      expect(getIssue(db, 306)).toMatchObject({
        auto_retry_next_at: "2026-06-10T08:10:00Z",
        auto_retry_reason: "provider_rate_limited",
        status: "in_progress"
      });
      expect(listIssueEvents(db, 306).map((event) => event.type)).toContain("issue.retry_after_scheduled");
    } finally {
      db.close();
    }
  });

  test("issue.supervisor_decision records PI judgement only", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 307, projectID: "demo", sessionID: "thread-307", turnID: "turn-old" });
      const beforeRun = listIssueRuns(db, 307).at(-1);
      const action = createPiAction(db, {
        action_type: "issue.supervisor_decision",
        id: "decision-action",
        issue_id: 307,
        payload_json: JSON.stringify({
          decision: { decision: "noop", rationale: "observe" },
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-307-attempt-1",
          issue_id: 307
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db }, action);

      expect(getIssue(db, 307)).toMatchObject({ status: "in_progress", auto_retry_next_at: "" });
      expect(listIssueRuns(db, 307).at(-1)).toEqual(beforeRun);
      expect(listIssueEvents(db, 307).map((event) => event.type)).toEqual(["issue.supervisor_decision"]);
    } finally {
      db.close();
    }
  });

  test("resume follow-up refuses stale issue/run/session preconditions", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 308, projectID: "demo", sessionID: "thread-308", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "stale-resume-action",
        issue_id: 308,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T06:59:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-308-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 308,
          prompt: "continue",
          provider: "codex",
          provider_session_id: "thread-308"
        }),
        project_id: "demo",
        status: "approved"
      });

      await expect(dispatchPiAction({ database: db, providers: { codex: provider } }, action))
        .rejects.toThrow("issue changed before PI action execution");
      expect(provider.calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-dispatch-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values (?, ?, ?, 'codex', ?, ?)`, [id, id, `/tmp/${id}`, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssueRunSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionID: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', ?, ?)`,
  [input.issueID, input.projectID, "2026-06-10T06:00:00Z", "2026-06-10T07:00:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, ?, '')`,
  [`issue-${input.issueID}-attempt-1`, input.issueID, input.sessionID, input.turnID, "2026-06-10T06:30:00Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, ?, ?)`,
  [`codex:${input.sessionID}`, input.sessionID, input.projectID, input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }), "2026-06-10T06:30:00Z", "2026-06-10T07:01:00Z"]);
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
