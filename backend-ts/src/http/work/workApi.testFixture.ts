import { type RunnerDatabase } from "../../db/database.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../../db/repositories/workLedger.ts";
import { getIssueAsWork, issueIDToWorkID } from "../../domain/work/issueAdapter.ts";
import { createDefaultRouter, createRequestHandler } from "../server.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import { apiClient, insertProject, useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const AUTH_TOKEN = "work-api-test-token";

  const openFixtureDatabase = useTestDatabase();

  const work = (id: string | number) => `/api/works/${encodeURIComponent(typeof id === "number" ? issueIDToWorkID(id) : id)}`;

  async function workApi(projectID = "demo", providers?: Record<string, ExecutorProvider>) {
    const db = await openFixtureDatabase();
    insertWorkProject(db, projectID);
    const router = createDefaultRouter({ database: db, ...(providers ? { providers } : {}) });
    const handle = createRequestHandler(router, AUTH_TOKEN);
    return {
      db,
      api: apiClient(router),
      unauthed: apiClient({ handle }),
      authed: apiClient({
        handle: (request: Request) => {
          request.headers.set("authorization", `Bearer ${AUTH_TOKEN}`);
          return handle(request);
        }
      })
    };
  }

  function insertWorkProject(db: RunnerDatabase, id: string): void {
    const timestamp = "2026-07-16T00:00:00Z";
    insertProject(db, id, { provider: "codex", model: "codex-default", auto_run: 0, created_at: timestamp, updated_at: timestamp });
  }

  function readyProvider(id: string): ExecutorProvider {
    return {
      id: id as ExecutorProviderId,
      capabilities: ["issue_execution"],
      async run() { return { runId: `${id}-unused` }; },
      runtimeStatus: () => ({
        active_sessions: 0,
        api_key_configured: id === "claude",
        mode: id === "claude" ? "sdk" : id === "pi-coding-agent" ? "local" : "app-server",
        ready: true,
        version: "fixture"
      })
    };
  }

  function audit(eventID: string, kind: "supervisor" | "user") {
    return {
      actor: { id: `actor-${eventID}`, kind },
      correlation_id: `correlation:${eventID}`,
      event_id: eventID,
      occurred_at: "2026-07-16T01:00:00Z",
      reason: `apply ${eventID}`
    };
  }

  function rowCount(db: RunnerDatabase, table: string): number {
    return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
  }

  function adapterAudits(db: RunnerDatabase): Array<Record<string, unknown>> {
    return db.sqlite.query<{ payload: string }, []>("select payload from issue_events where type='issue.work_adapter_write' order by id asc")
      .all().map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  }

  function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
    const [source, target] = [getIssueAsWork(db, issueID)!, getIssueAsWork(db, dependencyID)!];
    insertWorkRecord(db, source);
    insertWorkRecord(db, target);
    insertWorkRelationRecord(db, "demo", {
      actor: { id: "work-api-test", kind: "runner" },
      audit_event_ref: `work-api:${issueID}:${dependencyID}`,
      correlation_id: `work-api:${issueID}:${dependencyID}`,
      depends_on_work_id: target.id,
      kind: "depends_on",
      occurred_at: "2026-07-16T01:00:00.000Z",
      reason: "readiness API dependency",
      relation_id: `depends-on:${issueID}:${dependencyID}`,
      work_id: source.id
    });
  }
  return { AUTH_TOKEN, openFixtureDatabase, work, workApi, insertWorkProject, readyProvider, audit, rowCount, adapterAudits, addDependency };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
