import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE = "http://127.0.0.1:3008";
const roots: string[] = [];

afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true }); });

describe("native Automation API", () => {
  test("supports create, filters, detail editing, pause/resume, run-now, history, and live events", async () => {
    const root = await mkdtemp(join(tmpdir(), "automation-api-"));
    roots.push(root);
    const db = await openDatabase({ stateDir: root });
    const bus = new EventBus();
    const events: string[] = [];
    const stop = bus.observe((event) => events.push(event.type));
    try {
      db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', 'codex', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`);
      const router = createDefaultRouter({ bus, database: db });

      const created = await jsonRequest(router, "/api/automations", "POST", {
        id: "daily-review",
        mode: "propose",
        name: "Daily review",
        project_id: "demo",
        status: "active",
        trigger: { type: "cron", config: { expression: "0 9 * * *", timezone: "Asia/Shanghai" } },
        workflow_ref: "workflow:investigate@1"
      });
      expect(created.response.status).toBe(201);
      expect(created.body.automation).toMatchObject({ id: "automation:daily-review", revision: 0, status: "active" });

      const listed = await router.handle(new Request(`${BASE}/api/automations?project_id=demo&status=active&trigger_type=cron`));
      expect((await listed.json()) as Record<string, any>).toMatchObject({
        authority: { definition: "automation_definitions", runs: "automation_runs" },
        automations: [{ id: "automation:daily-review", trigger: { type: "cron" } }]
      });

      const updated = await jsonRequest(router, "/api/automations/automation%3Adaily-review", "PATCH", {
        expected_revision: 0,
        mode: "observe",
        name: "Daily review edited"
      });
      expect(updated.body.automation).toMatchObject({ mode: "observe", name: "Daily review edited", revision: 1 });

      const paused = await jsonRequest(router, "/api/automations/automation%3Adaily-review/status", "POST", {
        expected_revision: 1, status: "paused"
      });
      expect(paused.body.automation).toMatchObject({ revision: 2, status: "paused" });
      const resumed = await jsonRequest(router, "/api/automations/automation%3Adaily-review/status", "POST", {
        expected_revision: 2, status: "active"
      });
      expect(resumed.body.automation).toMatchObject({ revision: 3, status: "active" });

      const queued = await jsonRequest(router, "/api/automations/automation%3Adaily-review/run-now", "POST", {
        expected_revision: 3
      });
      expect(queued.response.status).toBe(202);
      expect(queued.body.run).toMatchObject({ automation_id: "automation:daily-review", status: "queued" });

      const detail = await router.handle(new Request(`${BASE}/api/automations/automation%3Adaily-review`));
      const body = await detail.json() as Record<string, any>;
      expect(body.runs).toEqual([expect.objectContaining({ status: "queued" })]);
      expect(body.events.map((event: Record<string, unknown>) => event.event_type)).toEqual(expect.arrayContaining([
        "automation.created.v1", "automation.definition_updated.v1", "automation.status_changed.v1", "automation.triggered.v1"
      ]));
      expect(events).toEqual(expect.arrayContaining([
        "automation.created", "automation.updated", "automation.status_changed", "automation.run_queued"
      ]));
    } finally {
      stop();
      db.close();
    }
  });

  test("rejects stale and inactive run-now requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "automation-api-"));
    roots.push(root);
    const db = await openDatabase({ stateDir: root });
    try {
      const router = createDefaultRouter({ database: db });
      await jsonRequest(router, "/api/automations", "POST", {
        id: "manual-review", name: "Manual review", status: "draft",
        trigger: { type: "manual", config: {} }, workflow_ref: "workflow:investigate@1"
      });
      const inactive = await jsonRequest(router, "/api/automations/automation%3Amanual-review/run-now", "POST", { expected_revision: 0 });
      expect(inactive.response.status).toBe(409);
      expect(inactive.body.message).toContain("only active");
      const stale = await jsonRequest(router, "/api/automations/automation%3Amanual-review/status", "POST", {
        expected_revision: 4, status: "active"
      });
      expect(stale.response.status).toBe(409);
      expect(stale.body.message).toContain("revision conflict");
    } finally { db.close(); }
  });
});

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, method: string, body: Record<string, unknown>) {
  const response = await router.handle(new Request(`${BASE}${path}`, {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method
  }));
  return { body: await response.json() as Record<string, any>, response };
}
