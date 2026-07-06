import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI automations API", () => {
  test("configures a manual source sync to intake automation", async () => {
    const fixture = await openFixture();
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const body = await jsonRequest(router, "/api/pi/automations", {
        body: JSON.stringify({
          enabled: true,
          filters: [{ source: "fixture-cli", event_scope: "recent" }],
          max_actions_per_run: 3,
          mode: "propose",
          name: "Manual fixture intake",
          source_policy: {
            intake_mode: "manual_micro_batch",
            micro_batch: { context_window_events: 5, max_new_events: 10 }
          },
          steps: [
            { type: "source_sync", cursor: "", watermark: "", idempotency_key: "fixture-sync" },
            { type: "context_bundle", cursor: "", watermark: "", idempotency_key: "fixture-bundle" },
            { type: "intake", skill_id: "fixture-intake", cursor: "", watermark: "", idempotency_key: "fixture-intake" }
          ],
          trigger: { type: "manual" }
        }),
        method: "POST"
      });

      expect(body.automation).toMatchObject({
        enabled: true,
        filters: [{ source: "fixture-cli", event_scope: "recent" }],
        max_actions_per_run: 3,
        mode: "propose",
        name: "Manual fixture intake",
        source_policy: { intake_mode: "manual_micro_batch" },
        trigger: { type: "manual" }
      });
      expect(body.automation.steps.map((step: { type: string }) => step.type)).toEqual([
        "source_sync", "context_bundle", "intake"
      ]);
      expect(body.automation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ cursor: "", idempotency_key: "fixture-sync", watermark: "" })
      ]));
    } finally {
      fixture.db.close();
    }
  });

  test("configures domain automation and excludes disabled rules from runnable list", async () => {
    const fixture = await openFixture();
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const enabled = await jsonRequest(router, "/api/pi/automations", {
        body: JSON.stringify({
          filters: [{ object: "attention_inbox_item", status: "new" }],
          mode: "draft",
          name: "New inbox item proposal",
          steps: [
            { type: "domain_skill", skill_id: "fixture-domain", cursor: "", watermark: "", idempotency_key: "domain-new" }
          ],
          trigger: { type: "schedule", every: "5m" }
        }),
        method: "POST"
      });
      const disabled = await jsonRequest(router, "/api/pi/automations", {
        body: JSON.stringify({
          enabled: false,
          filters: [{ object: "attention_inbox_item", status: "new" }],
          mode: "draft",
          name: "Disabled inbox proposal",
          steps: [
            { type: "domain_skill", skill_id: "fixture-domain", cursor: "", watermark: "", idempotency_key: "domain-disabled" }
          ],
          trigger: { type: "schedule", every: "5m" }
        }),
        method: "POST"
      });

      const runnable = await jsonRequest(router, "/api/pi/automations/runnable?trigger_type=schedule");
      expect(runnable.automations.map((item: { id: number }) => item.id)).toContain(enabled.automation.id);
      expect(runnable.automations.map((item: { id: number }) => item.id)).not.toContain(disabled.automation.id);
      expect(enabled.automation.steps[0]).toMatchObject({ type: "domain_skill", skill_id: "fixture-domain" });
      expect(disabled.automation.enabled).toBe(false);
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-automations-api-"));
  tempRoots.push(root);
  return { db: await openDatabase({ stateDir: join(root, "state") }), root };
}

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, init));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<Record<string, any>>;
}
