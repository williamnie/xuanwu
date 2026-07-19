import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { executePiAutomationLegacyCommand } from "./piAutomationCommands.ts";
import { createPiAutomation, updatePiAutomation, type PiAutomationInput } from "./piAutomations.ts";
import {
  backfillPiAutomationShadows,
  comparePiAutomationShadows,
  mapPiAutomationShadow,
  piAutomationShadowID
} from "./piAutomationShadow.ts";
import type { AutomationAudit } from "../../domain/automation/contracts.ts";

const roots: string[] = [];
const NOW = new Date("2026-07-19T04:00:00.000Z");

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("PI Automation W1 target shadow", () => {
  test("dry-runs and applies an idempotent definition/trigger/cursor/status/provenance mapping", async () => {
    const db = await fixture();
    try {
      const legacy = createPiAutomation(db, input(), NOW);
      const desired = mapPiAutomationShadow(legacy);
      expect(desired.projection).toMatchObject({
        definition: { id: piAutomationShadowID(legacy.id), next_run_at: null, status: "draft" },
        trigger: { config: { poll_interval_seconds: 300 }, type: "continuous" }
      });
      expect(desired.payload).toMatchObject({ expected_definition_status: "active", legacy_id: legacy.id });

      const preview = backfillPiAutomationShadows(db, { apply: false, audit: audit("preview") });
      expect(preview).toMatchObject({ created: 1, refreshed: 0, scanned: 1, unchanged: 0 });
      expect(preview.drift).toEqual([
        expect.objectContaining({ axis: "definition", detail: "target shadow definition is missing", legacy_id: legacy.id })
      ]);

      const first = backfillPiAutomationShadows(db, { apply: true, audit: audit("first") });
      expect(first).toMatchObject({ created: 1, drift: [], refreshed: 0, scanned: 1, unchanged: 0 });
      const row = db.sqlite.query<Record<string, unknown>, [string]>(
        "select status, next_run_at from automation_definitions where id=?"
      ).get(piAutomationShadowID(legacy.id));
      expect(row).toEqual({ next_run_at: null, status: "draft" });
      const event = db.sqlite.query<{ payload_json: string }, [string]>(`select payload_json from automation_events
        where automation_id=? and event_type='automation.legacy_pi_shadow_mapped.v1'`).get(piAutomationShadowID(legacy.id));
      expect(JSON.parse(event!.payload_json)).toMatchObject({
        expected_definition_status: "active",
        source_snapshot: {
          claim_retry: { retry_backoff_seconds: 30, run_timeout_ms: 120000 },
          cursor: { steps: [expect.objectContaining({ cursor: "cursor-a", watermark: "watermark-a" })] },
          definition: { source_policy: { quiet_hours: { end: "08:00", start: "22:00", timezone: "Asia/Shanghai" } } },
          trigger: { type: "schedule" }
        }
      });

      const second = backfillPiAutomationShadows(db, { apply: true, audit: audit("second") });
      expect(second).toMatchObject({ created: 0, drift: [], refreshed: 0, scanned: 1, unchanged: 1 });
      expect(second.parity_checksum).toBe(first.parity_checksum);
    } finally {
      db.close();
    }
  });

  test("refreshes a legitimate legacy revision but fails closed on target drift", async () => {
    const db = await fixture();
    try {
      const legacy = createPiAutomation(db, input(), NOW);
      backfillPiAutomationShadows(db, { apply: true, audit: audit("seed") });
      updatePiAutomation(db, legacy.id, { enabled: false, name: "Changed legacy" }, new Date("2026-07-19T04:01:00Z"));
      const refreshed = backfillPiAutomationShadows(db, { apply: true, audit: audit("refresh") });
      expect(refreshed).toMatchObject({ created: 0, drift: [], refreshed: 1, unchanged: 0 });
      expect(db.sqlite.query("select name, status from automation_definitions where id=?")
        .get(piAutomationShadowID(legacy.id))).toEqual({ name: "Changed legacy", status: "draft" });

      db.sqlite.run("update automation_definitions set name='tampered' where id=?", [piAutomationShadowID(legacy.id)]);
      const parity = comparePiAutomationShadows(db);
      expect(parity.drift).toEqual([
        expect.objectContaining({ axis: "definition", detail: "target projection checksum drifted" })
      ]);
      expect(() => backfillPiAutomationShadows(db, { apply: true, audit: audit("drift") }))
        .toThrow("target drifted from its last provenance event");
      expect(db.sqlite.query("select name from automation_definitions where id=?")
        .get(piAutomationShadowID(legacy.id))).toEqual({ name: "tampered" });
    } finally {
      db.close();
    }
  });

  test("keeps the successful legacy result and emits structured audit when shadow fails", async () => {
    const db = await fixture();
    try {
      const events: Record<string, unknown>[] = [];
      const result = executePiAutomationLegacyCommand(db, { input: input(), operation: "create" }, {
        auditFailure: (event) => events.push(event),
        now: NOW,
        shadowEnabled: true,
        shadowWrite: () => { throw new Error("injected shadow failure"); }
      });
      expect(result.automation.id).toBe(1);
      expect(result.shadow).toMatchObject({ enabled: true, error: "injected shadow failure", outcome: "failed" });
      expect(db.sqlite.query("select count(*) as count from pi_automations").get()).toEqual({ count: 1 });
      expect(db.sqlite.query("select count(*) as count from automation_definitions").get()).toEqual({ count: 0 });
      expect(events).toEqual([expect.objectContaining({
        actor_id: "pi-automation-command-seam",
        correlation_id: "legacy-pi-automation:create:1:2026-07-19T04:00:00.000Z",
        event_id: "automation-shadow:create:1:2026-07-19T04:00:00.000Z",
        gate: expect.objectContaining({ authority: "deterministic_policy", decision: "allow" }),
        legacy_id: 1,
        operation: "create",
        outcome: "failed",
        schema_version: "xuanwu.automation-shadow-audit.v1"
      })]);
    } finally {
      db.close();
    }
  });

  test("turns W1 off to restore pure legacy writes", async () => {
    const db = await fixture();
    try {
      const result = executePiAutomationLegacyCommand(db, { input: input(), operation: "create" }, {
        now: NOW,
        shadowEnabled: false
      });
      expect(result.shadow).toEqual({ enabled: false });
      expect(db.sqlite.query("select count(*) as count from pi_automations").get()).toEqual({ count: 1 });
      expect(db.sqlite.query("select count(*) as count from automation_definitions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "pi-automation-shadow-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function input(): PiAutomationInput {
  return {
    enabled: true,
    filters: [{ status: "new" }],
    max_actions_per_run: 2,
    mode: "propose",
    name: "Legacy scheduled intake",
    retry_backoff_seconds: 30,
    run_timeout_ms: 120000,
    source_policy: { quiet_hours: { end: "08:00", start: "22:00", timezone: "Asia/Shanghai" } },
    steps: [{
      cursor: "cursor-a",
      idempotency_key: "step-a",
      skill_id: "pi-domain-proposal",
      type: "domain_skill",
      watermark: "watermark-a"
    }],
    trigger: { every: "5m", timezone: "Asia/Shanghai", type: "schedule" }
  };
}

function audit(suffix: string): AutomationAudit {
  return {
    actor_id: "migration-test",
    actor_kind: "system",
    correlation_id: `automation-shadow-test:${suffix}`,
    event_id: `automation-shadow-test:${suffix}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "test:w1" },
    occurred_at: NOW.toISOString(),
    reason: `test automation shadow ${suffix}`
  };
}
