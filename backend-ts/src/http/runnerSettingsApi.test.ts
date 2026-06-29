import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { projectLoopMaxParallelProjects, setProjectLoopMaxParallelProjects } from "../runner/projectLoopManager.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-runner-settings-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  setProjectLoopMaxParallelProjects(1);
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Runner settings API", () => {
  test("saves and applies the global project concurrency setting", async () => {
    const database = await openFixtureDatabase();
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const router = createDefaultRouter({ config, database });

      const empty = await router.handle(new Request(`${BASE_URL}/api/runner/settings`));
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({
        max_parallel_projects: 1,
        min_parallel_projects: 1,
        max_parallel_projects_limit: 8
      });

      const saved = await request(router, { max_parallel_projects: 3 });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ max_parallel_projects: 3 });
      expect(config.runner.maxParallelProjects).toBe(3);
      expect(projectLoopMaxParallelProjects()).toBe(3);

      const raw = JSON.parse(await readFile(localSettingsPath(database), "utf8"));
      expect(raw.runner).toEqual({ maxParallelProjects: 3 });
    } finally {
      database.close();
    }
  });

  test("rejects invalid concurrency values", async () => {
    const database = await openFixtureDatabase();
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const response = await request(createDefaultRouter({ config, database }), { max_parallel_projects: 0 });
      expect(response.status).toBe(400);
      expect(config.runner.maxParallelProjects).toBe(1);
    } finally {
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}/api/runner/settings`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function localSettingsPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "runner-settings.local.json");
}
