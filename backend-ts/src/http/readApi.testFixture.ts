import { expect } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";
import { isProjectLoopActive } from "../runner/projectLoopManager.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunInput } from "../providers/types.ts";
import { apiClient, FIXTURE_TIME, insertIssue, insertProject, useTempDirs, useTestDatabase, waitFor } from "../testing/harness.ts";



export function createTestFixture() {
  const openFixtureDatabase = useTestDatabase("xuanwu-bun-read-api-");

  const tempDir = useTempDirs("xuanwu-bun-project-cwd-");

  const CAPABILITIES = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];

  const NOT_FOUND = { message: "资源不存在" };

  const RUNNING_DELETE = { message: "运行中的 issue 不能删除，请先取消执行" };

  async function readApi(options: { autoRun?: boolean; project?: boolean; providers?: Record<string, ExecutorProvider> } = {}) {
    const database = await openFixtureDatabase();
    if (options.project !== false) addProject(database, "demo", options.autoRun ? { auto_run: 1, provider: FAKE } : {});
    return { database, api: apiClient(createDefaultRouter({ database, ...(options.providers ? { providers: options.providers } : {}) })) };
  }

  async function autoRunApi() {
    const provider = new FakeExecutionProvider();
    return { ...(await readApi({ autoRun: true, providers: { [provider.id]: provider } })), provider };
  }

  function addProject(db: RunnerDatabase, id: string, values: Record<string, SQLQueryBindings> = {}): void {
    insertProject(db, id, { name: id === "demo" ? "Demo" : id, provider: "codex", sort_order: 1, ...values });
  }

  function addIssue(db: RunnerDatabase, title: string, status: string, values: Record<string, SQLQueryBindings> = {}): number {
    return insertIssue(db, { title, status, source_session_id: "", ...values });
  }

  function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
    for (const id of [issueID, dependencyID]) insertWorkRecord(db, getIssueAsWork(db, id)!);
    const key = `${issueID}:${dependencyID}`;
    insertWorkRelationRecord(db, "demo", {
      actor: { id: "read-api-test", kind: "runner" },
      audit_event_ref: `read-api-test:${key}`,
      correlation_id: `read-api-test:${key}`,
      depends_on_work_id: issueIDToWorkID(dependencyID),
      kind: "depends_on",
      occurred_at: FIXTURE_TIME,
      reason: "read API dependency fixture",
      relation_id: `read-api-dependency:${key}`,
      work_id: issueIDToWorkID(issueID)
    });
  }

  function expectClaimed(db: RunnerDatabase, issueId: number, extra: Record<string, unknown> = {}): void {
    expect(db.sqlite.query<Record<string, unknown>, [number]>(
      "select i.status, i.attempt_count, r.provider_session_id, r.provider_turn_id from issues i join issue_runs r on r.issue_id=i.id where i.id=?"
    ).get(issueId)).toMatchObject({
      status: "in_progress",
      provider_session_id: `fake-session-${issueId}`,
      provider_turn_id: `fake-turn-${issueId}`,
      ...extra
    });
  }

  const FAKE = "fake-execution-only" as ExecutorProviderId;

  class FakeExecutionProvider implements ExecutorProvider {
    readonly id = FAKE;
    readonly capabilities = ["issue_execution"] as const;
    readonly inputs: ProviderRunInput[] = [];
  
    async run(input: ProviderRunInput) {
      this.inputs.push(input);
      return {
        runId: `fake-run-${input.issueId}`,
        session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
      };
    }
  }

  async function waitForProviderStart(provider: FakeExecutionProvider): Promise<void> {
    await waitFor(() => provider.inputs.length === 1, "timed out waiting for condition");
    await waitFor(() => !isProjectLoopActive("demo"), "timed out waiting for condition");
  }
  return { openFixtureDatabase, tempDir, CAPABILITIES, NOT_FOUND, RUNNING_DELETE, readApi, autoRunApi, addProject, addIssue, addDependency, expectClaimed, FAKE, FakeExecutionProvider, waitForProviderStart };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
