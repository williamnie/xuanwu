import { type RunnerDatabase } from "../db/database.ts";

import {
  ProviderInterruptedError,
  type ExecutorProvider,
  type InterruptInput,
  type ProviderRunInput
} from "../providers/types.ts";
import { useTestDatabase } from "../testing/harness.ts";

export const openFixtureDatabase = useTestDatabase();

export class InterruptCaptureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["interrupt"] as const;
  readonly interrupts: InterruptInput[] = [];

  constructor(private readonly behavior: { hang?: boolean; reject?: Error } = {}) {}

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
    if (this.behavior.reject) throw this.behavior.reject;
    if (this.behavior.hang) return await new Promise(() => {});
  }
}

export class ActiveInterruptProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities = ["interrupt"] as const;
  readonly interruptScope = "active" as const;
  readonly interrupts: InterruptInput[] = [];

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }
}

export class RestartableExecutionProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "interrupt"] as const;
  private rejectRun?: (error: Error) => void;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: "codex",
      type: "turn_started",
      status: "inProgress",
      session: { provider: "codex", sessionId: "thread-running", turnId: "turn-running" }
    });
    return await new Promise<never>((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    const rejectRun = this.rejectRun;
    setTimeout(() => rejectRun?.(new Error("old turn interrupted")), 0);
  }
}

export class ImmediatelyInterruptedProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities = ["issue_execution", "interrupt"] as const;
  readonly interruptScope = "active" as const;
  private rejectRun?: (error: Error) => void;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: this.id,
      session: { provider: this.id, sessionId: "pi-running" },
      status: "running",
      type: "provider.session_started"
    });
    return await new Promise<never>((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }

  async interrupt(): Promise<void> {
    this.rejectRun?.(new ProviderInterruptedError("pi interrupted"));
  }
}

export function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

export function insertIssue(db: RunnerDatabase, projectId: string, status: string, threadID: string, turnID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, "Interrupt", status, threadID, turnID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

export function insertOpenRun(db: RunnerDatabase, issueId: number, provider = "codex"): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
     values (?, ?, ?, ?, ?, ?)`,
    [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", provider, "2026-01-01T00:00:00Z"]
  );
}

export function insertAgentSession(
  db: RunnerDatabase,
  issueID: number,
  projectID: string,
  sessionID: string,
  status: string
): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
     values (?, 'codex', ?, ?, ?, ?, '{}', ?, ?)`,
    [
      `codex:${sessionID}`,
      sessionID,
      projectID,
      issueID,
      status,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
}

export function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select status, provider_session_id, provider_turn_id, ended_at, exit_reason, error
     from issue_runs where issue_id = ? order by attempt desc limit 1`
  ).get(issueId) ?? null;
}

export function latestAttempt(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(`
    select attempt.status, attempt.terminal_reason, attempt.terminal_source_ref
    from run_attempts attempt join issue_runs run on run.id=attempt.issue_run_id
    where run.issue_id=? order by run.attempt desc, attempt.sequence desc limit 1
  `).get(issueId) ?? null;
}

export function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

export function eventWithType(db: RunnerDatabase, type: string): { payload: string; type: string } | undefined {
  return listEvents(db).find((event) => event.type === type);
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
