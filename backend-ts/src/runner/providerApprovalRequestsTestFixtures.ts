import { type RunnerDatabase } from "../db/database.ts";

import type { ExecutorProvider, ProviderEvent, ProviderRunInput, SessionRef } from "../providers/types.ts";

import { useTestDatabase } from "../testing/harness.ts";

export const openFixtureDatabase = useTestDatabase();

export class ApprovalEventProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  constructor(private readonly options: { resolve?: boolean } = {}) {}

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-approval", turnId: "turn-approval" };
    const requested: ProviderEvent = approvalRequestedEvent(session);
    input.onEvent?.(requested);
    input.onEvent?.(requested);
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session,
      text: "ordinary command output says approval denied"
    });
    if (this.options.resolve) input.onEvent?.(approvalResolvedEvent(session));
    return { runId: "codex-run", session };
  }
}

export class TextOnlyProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-text", turnId: "turn-text" };
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session,
      text: "ordinary command output says approval denied"
    });
    return { runId: "codex-run", session };
  }
}

export class FastApprovalAuditProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-fast", turnId: "turn-fast" };
    const event = fastResolvedEvent(session);
    input.onEvent?.(event);
    input.onEvent?.(event);
    return { runId: "codex-run", session };
  }
}

export function approvalRequestedEvent(session: SessionRef): ProviderEvent {
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "pending",
    raw: {
      method: "approval/requested",
      payload: JSON.stringify({
        id: "approval-runtime-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
          itemId: "approval-runtime-1",
          threadId: "thread-approval",
          turnId: "turn-approval"
        }
      })
    }
  };
}

export function approvalResolvedEvent(session: SessionRef): ProviderEvent {
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "cancel",
    raw: {
      method: "approval/resolved",
      payload: JSON.stringify({ decision: "cancel", id: "approval-runtime-1", scope: "turn" })
    }
  };
}

export function fastResolvedEvent(session: SessionRef): ProviderEvent {
  const payload = {
    decision: "approve",
    fast_decision: "approve-now",
    id: "approval-fast-1",
    latency_ms: 7,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-fast", turnId: "turn-fast" },
    reason: "current repo read-only command",
    request_summary: "command=cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
    request_type: "command",
    rule_id: "pi_approval_allow_current_repo_read_only_once",
    scope: "turn"
  };
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "approve",
    payload,
    raw: {
      method: "approval/fast_resolved",
      payload: JSON.stringify(payload)
    }
  };
}

export function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

export function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Runtime", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

export function failingAuditDatabase(): RunnerDatabase {
  return {
    close: () => {},
    path: "/tmp/failing-audit.sqlite",
    readonly: false,
    sqlite: {
      run: () => {
        throw new Error("database is locked");
      }
    },
    transaction: () => {
      throw new Error("database is locked");
    }
  } as unknown as RunnerDatabase;
}
