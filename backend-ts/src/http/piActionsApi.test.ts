import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { EventBus } from "../events/bus.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-actions-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI actions API", () => {
  test("lists pending actions and publishes PI action SSE events", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const bus = new EventBus();
      const router = createDefaultRouter({ bus, database });
      const stream = await router.handle(new Request(`${BASE_URL}/api/events`));
      const reader = stream.body?.getReader();
      await reader?.read();

      const action = createPiRunnerActions(database, {
        bus,
        conversationID: "conv-1",
        project
      }).enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/actions?project_id=demo&status=pending`));

      expect(response.status).toBe(200);
      expect((await response.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([action.action_id]);
      expect(listPiActions(database, { status: "pending" })).toHaveLength(1);
      const event = await reader?.read();
      await reader?.cancel();
      const text = new TextDecoder().decode(event?.value);
      expect(text).toContain('"type":"pi.action_pending"');
      expect(text).toContain(`\\"action_id\\":\\"${action.action_id}\\"`);
      expect(text).toContain('\\"risk_level\\":\\"medium\\"');
    } finally {
      database.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "Queue me", "triage", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("missing project");
  return project;
}
