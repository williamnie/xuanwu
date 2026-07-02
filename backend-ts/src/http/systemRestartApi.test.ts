import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const CALLBACK_WAIT_ATTEMPTS = 20;
const CALLBACK_WAIT_INTERVAL_MS = 5;
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-system-restart-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("System restart API", () => {
  test("schedules a supervised restart and stops provider transports first", async () => {
    const database = await openFixtureDatabase();
    let stopped = 0;
    let restarted = 0;
    try {
      const router = createDefaultRouter({
        database,
        providers: { codex: fakeCodexProvider(async () => { stopped += 1; }) },
        restartDelayMs: 0,
        restartProcess: () => { restarted += 1; }
      });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/restart`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" }
      }));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ok: true, restart_scheduled: true });
      await waitFor(() => restarted === 1);
      expect(stopped).toBe(1);
    } finally {
      database.close();
    }
  });
});

function fakeCodexProvider(stop: () => Promise<void>): ExecutorProvider {
  return {
    capabilities: ["issue_execution"],
    id: "codex",
    run: async () => ({ runId: "codex:fake" }),
    stop
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < CALLBACK_WAIT_ATTEMPTS; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(CALLBACK_WAIT_INTERVAL_MS);
  }
  throw new Error("restart callback was not invoked");
}
