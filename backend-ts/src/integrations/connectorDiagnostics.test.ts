import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { buildConnectorDiagnosticBundle, connectorTestHistory, probeConnectorConnection } from "./connectorDiagnostics.ts";

const NOW = new Date("2026-07-18T03:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("connector diagnostics", () => {
  test("reports unconfigured without making a network request", async () => {
    let called = false;
    const result = await probeConnectorConnection({
      config: buildConfig(),
      connectorID: "github-events",
      fetch: async () => { called = true; return new Response(null, { status: 200 }); },
      now: () => NOW
    });
    expect(result).toMatchObject({ ok: false, state: "unconfigured", error: { code: "not_configured" } });
    expect(called).toBe(false);
  });

  test("normalizes expired, rate-limited and offline probes without response bodies", async () => {
    const config = buildConfig({ githubToken: "fixture-connector-secret" });
    const expired = await probeConnectorConnection({
      config, connectorID: "github-events", now: () => NOW,
      fetch: async () => new Response("fixture-connector-secret provider body", { status: 401 })
    });
    const limited = await probeConnectorConnection({
      config, connectorID: "github-events", now: () => NOW,
      fetch: async () => new Response("limited body", { headers: { "retry-after": "120" }, status: 429 })
    });
    const offline = await probeConnectorConnection({
      config, connectorID: "github-events", now: () => NOW,
      fetch: async () => { throw new Error("fixture-connector-secret offline"); }
    });
    const text = JSON.stringify({ expired, limited, offline });

    expect(expired).toMatchObject({ ok: false, state: "degraded", error: { code: "credential_expired" }, http_status: 401 });
    expect(limited).toMatchObject({ ok: false, state: "rate_limited", rate_limit: { retry_after_seconds: 120 } });
    expect(offline).toMatchObject({ ok: false, state: "disconnected", error: { code: "network_unreachable" } });
    expect(text).not.toContain("fixture-connector-secret");
    expect(text).not.toContain("provider body");
  });

  test("does not treat a Feishu HTTP 200 error envelope as healthy", async () => {
    const config = buildConfig({ integrations: { feishu: { appId: "cli_a", appSecret: "feishu-fixture-secret" } } });
    const result = await probeConnectorConnection({
      config,
      connectorID: "feishu",
      fetch: async () => new Response(JSON.stringify({ code: 10003, msg: "invalid app secret" }), { status: 200 }),
      now: () => NOW
    });

    expect(result).toMatchObject({ ok: false, state: "degraded", error: { code: "credential_expired" }, http_status: 200 });
    expect(JSON.stringify(result)).not.toContain("feishu-fixture-secret");
  });

  test("derives bounded backoff from audited test results and emits a redacted bundle", async () => {
    const fixture = await databaseFixture();
    try {
      const result = {
        checked_at: NOW.toISOString(),
        error: { code: "rate_limited", message: "Connector rate limit was reached" },
        ok: false,
        rate_limit: { retry_after_seconds: 120, reset_at: "2026-07-18T03:02:00.000Z" },
        state: "rate_limited"
      };
      for (let index = 0; index < 2; index += 1) {
        createPiActionEvent(fixture.db, {
          action_id: `connector-test:${index}`,
          event_type: "connector.tested",
          payload_json: JSON.stringify({ connector_id: "github-events" }),
          result_json: JSON.stringify(result)
        });
      }
      createPiActionEvent(fixture.db, {
        action_id: "connector-test:malformed",
        event_type: "connector.tested",
        payload_json: "not-json",
        result_json: JSON.stringify(result)
      });
      const history = connectorTestHistory(fixture.db, "github-events", new Date("2026-07-18T03:00:30.000Z"));
      const config = buildConfig({ githubToken: "diagnostic-secret", stateDir: fixture.dir });
      const bundle = buildConnectorDiagnosticBundle({ config, database: fixture.db, now: () => NOW });
      const text = JSON.stringify(bundle);

      expect(history).toMatchObject({ attempts: 2, blocked: true, retry_at: "2026-07-18T03:02:00.000Z" });
      const plan = fixture.db.sqlite.query<{ detail: string }, [string]>(`explain query plan
        select payload_json, result_json from pi_action_events
        where event_type='connector.tested' and json_valid(payload_json)
          and json_extract(payload_json, '$.connector_id')=?
        order by id desc limit 20
      `).all("github-events").map((row) => row.detail);
      expect(plan.some((detail) => detail.includes("idx_pi_action_events_connector_test_history"))).toBe(true);
      expect(bundle).toMatchObject({ schema_version: "xuanwu.connector-diagnostics.v1" });
      expect(text).not.toContain("diagnostic-secret");
    } finally {
      fixture.db.close();
    }
  });
});

async function databaseFixture(): Promise<{ db: RunnerDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "connector-diagnostics-"));
  roots.push(dir);
  return { db: await openDatabase({ stateDir: dir }), dir };
}
