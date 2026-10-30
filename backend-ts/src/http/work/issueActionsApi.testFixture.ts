import { type RunnerDatabase } from "../../db/database.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../../providers/types.ts";
import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";

export type IssueFixture = {
  autoRetryNextAt?: string;
  autoRetryReason?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  error?: string;
  projectId: string;
  status: string;
  title: string;
};

export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

  class RetryExecutionProvider implements ExecutorProvider {
    readonly id = "fake-execution-only" as const;
    readonly capabilities = ["issue_execution"] as const;
    readonly issueIDs: number[] = [];
  
    async run(input: ProviderRunInput): Promise<ProviderRunResult> {
      this.issueIDs.push(input.issueId);
      return { runId: `retry-run-${input.issueId}` };
    }
  }

  function issueAction(
    db: RunnerDatabase,
    id: number,
    action: "cancel" | "enqueue" | "retry",
    provider?: ExecutorProvider,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const providers = provider ? { [provider.id]: provider } : undefined;
    return createDefaultRouter({ database: db, providers }).handle(new Request(`${BASE_URL}/api/issues/${id}/${action}`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", ...extraHeaders }
    }));
  }

  function issuePatch(
    db: RunnerDatabase,
    id: number,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    return createDefaultRouter({ database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...extraHeaders }
    }));
  }

  function managedExecutorHeaders(threadID: string): Record<string, string> {
    return {
      "x-codex-client": "xuanwu-cli",
      "x-xuanwu-caller-thread-id": threadID,
      "x-xuanwu-managed-execution": "1"
    };
  }

  function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
    db.sqlite.run(
      `insert into issues
      (project_id, title, status, error, codex_thread_id, codex_turn_id,
       auto_retry_next_at, auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issue.projectId,
        issue.title,
        issue.status,
        issue.error ?? "",
        issue.codexThreadId ?? "",
        issue.codexTurnId ?? "",
        issue.autoRetryNextAt ?? "",
        issue.autoRetryReason ?? "",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      ]
    );
    const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
    if (!row) throw new Error("missing inserted issue id");
    return row.id;
  }

  function insertProject(
    db: RunnerDatabase,
    id: string,
    options: { autoRun?: number; provider?: string } = {}
  ): void {
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, id, `/tmp/${id}`, options.provider ?? "codex", options.autoRun ?? 0,
        1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error("condition was not met");
  }

  function insertOpenRun(db: RunnerDatabase, issueId: number): void {
    db.sqlite.run(
      `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
      [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", "2026-01-01T00:00:00Z"]
    );
  }

  function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
    return db.sqlite.query<Record<string, unknown>, [number]>(
      "select status, ended_at, exit_reason from issue_runs where issue_id = ? order by attempt desc limit 1"
    ).get(issueId) ?? null;
  }

  function getIssueStatus(db: RunnerDatabase, issueId: number): string {
    return db.sqlite.query<{ status: string }, [number]>(
      "select status from issues where id=?"
    ).get(issueId)?.status ?? "";
  }

  function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
    return db.sqlite.query<{ payload: string; type: string }, []>(
      "select type, payload from issue_events order by id asc"
    ).all();
  }

  function eventWithType(db: RunnerDatabase, type: string): { payload: string; type: string } | undefined {
    return listEvents(db).find((event) => event.type === type);
  }
  return { BASE_URL, openFixtureDatabase, RetryExecutionProvider, issueAction, issuePatch, managedExecutorHeaders, insertIssue, insertProject, waitFor, insertOpenRun, latestRun, getIssueStatus, listEvents, eventWithType };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
