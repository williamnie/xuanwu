import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const AUTH_TOKEN = "work-api-idempotent-enqueue-test-token";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("Work HTTP idempotent enqueue", () => {
  test("accepts enqueue for an existing todo Work and records an audited loop kick", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issue = createIssue(db, {
        project_id: "demo",
        status: "todo",
        title: "Queued without active Run"
      });
      const workID = issueIDToWorkID(issue.id);
      const handle = createRequestHandler(createDefaultRouter({ database: db }), AUTH_TOKEN);
      const detail = await handle(new Request(`${BASE_URL}/api/works/${workID}`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` }
      }));
      const work = (await detail.json() as { work: { revision: number } }).work;

      const response = await handle(new Request(`${BASE_URL}/api/works/${workID}/actions/enqueue`, {
        body: JSON.stringify({
          audit: {
            actor: { id: "supervisor-live-kick", kind: "supervisor" },
            correlation_id: "idempotent-enqueue-http",
            event_id: "idempotent-enqueue-http-v1",
            occurred_at: "2026-07-26T04:45:00Z",
            reason: "wake an already queued Work"
          },
          expected_revision: work.revision
        }),
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json"
        },
        method: "POST"
      }));
      const body = await response.json() as { mutation: { applied: boolean }; work: { revision: number; status: string } };
      const audit = db.sqlite.query<{ payload: string }, [number, string]>(
        "select payload from issue_events where issue_id=? and type=? order by id desc limit 1"
      ).get(issue.id, "issue.work_adapter_write");

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ mutation: { applied: true }, work: { revision: work.revision, status: "todo" } });
      expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({
        operation: "enqueue",
        outcome: "applied",
        requested: { idempotent: true, to: "todo" }
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-work-api-enqueue-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  const timestamp = "2026-07-26T04:45:00Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 0, ?, ?)`,
    [id, id, `/tmp/${id}`, timestamp, timestamp]
  );
}
