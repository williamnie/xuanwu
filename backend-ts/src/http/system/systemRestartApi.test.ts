import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorProvider } from "../../providers/types.ts";
import type { SystemRestartAuditEvent } from "./systemRestartApi.ts";
import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const BASE_URL = "http://127.0.0.1:3008";
const CALLBACK_WAIT_ATTEMPTS = 20;
const CALLBACK_WAIT_INTERVAL_MS = 5;
const openFixtureDatabase = useTestDatabase();

describe("System restart API", () => {
  test("schedules a supervised restart and stops provider transports first", async () => {
    const database = await openFixtureDatabase();
    let stopped = 0;
    let restarted = 0;
    const audit: SystemRestartAuditEvent[] = [];
    const router = createDefaultRouter({
      auditSystemRestart: (event) => audit.push(event),
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
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "system.restart",
      actor: "authorized_api",
      decision: "accepted",
      source: "advanced_runtime"
    });
  });

  test("rejects unmanaged restart and records the failed attempt", async () => {
    const audit: SystemRestartAuditEvent[] = [];
    const router = createDefaultRouter({
      auditSystemRestart: (event) => audit.push(event),
      supervisorManaged: false
    });

    const response = await router.handle(new Request(`${BASE_URL}/api/system/restart`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" }
    }));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "system.restart",
      decision: "rejected",
      reason: "service is not managed by launchd/systemd"
    });
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
