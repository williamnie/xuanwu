import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultRouter } from "./server.ts";
import {
  createGoParityFixtureDatabase, goAgentProfile, goCronTask, goIssue, goIssueEvent,
  goIssueRun, goIssueTemplate, goIssueWithLatestRun, goNightlyBatch, goProject, openGoDatabase, type FixtureDatabase
} from "./goParityFixtures.testSupport.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-go-parity-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun API reads a Go database directly", () => {
  test("returns Go-shaped data for frontend read endpoints", async () => {
    const { database, root } = await openFixtureRuntime();
    try {
      const router = createDefaultRouter({ database });
      for (const [path, expected] of parityCases()) await expectJson(router, path, expected);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function openFixtureRuntime(): Promise<{ database: FixtureDatabase; root: string }> {
  const root = await tempRoot();
  const dbPath = join(root, "data", "app.db");
  await createGoParityFixtureDatabase(dbPath);
  return { database: await openGoDatabase(dbPath, join(root, "state")), root };
}

function parityCases(): Array<[string, unknown]> {
  return [
    ["/api/projects", [goProject()]], ["/api/agent-profiles", [goAgentProfile()]],
    ["/api/issue-templates", [goIssueTemplate()]], ["/api/issues?projectId=demo", [goIssueWithLatestRun()]],
    ["/api/issues/1/events", [goIssueEvent()]], ["/api/issues/1/runs", [goIssueRun()]],
    ["/api/cron-tasks", [goCronTask()]], ["/api/nightly-batches", [goNightlyBatch()]],
    ["/api/sessions/preferences", { last_project_id: "demo" }]
  ];
}

async function expectJson(router: ReturnType<typeof createDefaultRouter>, path: string, expected: unknown): Promise<void> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expected);
}
