import { afterEach } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../../providers/types.ts";
import { setProjectLoopMaxParallelProjects } from "../../runner/projectLoopManager.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const fixtureDb = useTestDatabase();

  afterEach(() => setProjectLoopMaxParallelProjects(1));

  const NO_AUTO_RUN_SETTLE_MS = 25;

  function insertProject(
    db: RunnerDatabase,
    id: string,
    options: { autoRun?: number; provider?: string } = {}
  ): void {
    db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)`, [id, id, `/tmp/${id}`, options.provider ?? "codex",
        options.autoRun ?? 0, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
  }

  function insertIssue(db: RunnerDatabase, input: { issueID: number; projectID: string; status: string }): void {
    db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, ?, 'Queue me', ?, ?, ?)`,
    [input.issueID, input.projectID, input.status, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
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
    readonly capabilities = ["issue_execution", "resume_session", "interrupt"] as const;
    readonly id = "codex" as const;
    readonly inputs: ProviderRunInput[] = [];
  
    async run(input: ProviderRunInput) {
      this.inputs.push(input);
      return {
        runId: `codex-run-${input.issueId}`,
        session: { provider: this.id, sessionId: `codex-session-${input.issueId}`, turnId: `codex-turn-${input.issueId}` }
      };
    }
  
    async interrupt(input: { reason: string; session: { sessionId: string; turnId?: string } }): Promise<void> {
      this.calls.push({
        reason: input.reason,
        sessionId: input.session.sessionId,
        turnId: input.session.turnId ?? ""
      });
    }
  
    async recover(input: Parameters<NonNullable<ExecutorProvider["recover"]>>[0]) {
      const result = await this.sendSessionMessage({ prompt: input.prompt, sessionId: input.session.sessionId });
      return { runId: `codex:${result.sessionId}:${result.turn_id}`,
        session: { provider: this.id, sessionId: result.sessionId, turnId: result.turn_id } };
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

  async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error("condition timed out");
  }
  return { fixtureDb, NO_AUTO_RUN_SETTLE_MS, insertProject, insertIssue, insertIssueRunSession, SupervisorProvider, waitUntil };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
