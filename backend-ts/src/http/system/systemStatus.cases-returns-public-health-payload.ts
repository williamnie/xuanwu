import { expect, test } from "bun:test";
import { join } from "node:path";
import { createDefaultRouter, createRequestHandler } from "../server.ts";
import { CLAUDE_AGENT_SDK_VERSION } from "../../providers/claude/provider.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { projectPendingCompactEventSummaries, updateEventSummaryProjectionSwitch } from "../../db/repositories/compactEventSummaryProjection.ts";
import { insertProject } from "../../testing/harness.ts";
import type { TestFixture } from "./systemStatus.testFixture.ts";

export function registerReturnsPublicHealthPayloadCases(testScope: TestFixture) {
  const { BASE_URL, CODEX_CAPABILITIES, CLAUDE_CAPABILITIES, systemStatus } = testScope;
  test("returns public health payload", async () => {
      const router = createDefaultRouter();
  
      const response = await router.handle(new Request(`${BASE_URL}/health`));
  
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    });
  
  test("exposes an authenticated Core health route for the Web reconnect probe", async () => {
      const router = createDefaultRouter();
      const handle = createRequestHandler(router, "status-secret");
  
      const denied = await handle(new Request(`${BASE_URL}/api/health`));
      const allowed = await handle(new Request(`${BASE_URL}/api/health`, {
        headers: { authorization: "Bearer status-secret" }
      }));
  
      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ role: "core", status: "ok" });
    });
  
  test("returns a compact authenticated Web-shell status without heavy projections", async () => {
      const { body, status } = await systemStatus({ claudeMode: "sdk", secret: "status-secret" }, {
        path: "/api/system/status?compact=1",
        route: { startedAt: new Date("2026-05-28T00:00:00.000Z") }
      });
      expect(status).toBe(200);
      expect(body.service.alive).toBe(true);
      expect(body.db.ok).toBe(true);
      expect(body.codex.command_ok).toBe(true);
      expect(body.pi_guardian.watchdog).toBeDefined();
      expect(body.event_projection).toBeUndefined();
      expect(body.run_progress_projection).toBeUndefined();
      expect(body.observability).toBeUndefined();
    });
  
  test("returns service db auth and config summary", async () => {
      const { body, status } = await systemStatus({ claudeMode: "sdk", secret: "status-secret" }, {
        route: { startedAt: new Date("2026-05-28T00:00:00.000Z") }
      });
  
      expect(status).toBe(200);
      expect(body.service.alive).toBe(true);
      expect(body.service.runtime).toBe("bun");
      expect(body.service.version).not.toBe("0.0.0-dev");
      expect(body.service.build).toMatchObject({
        artifact: "xuanwu",
        bun_version: Bun.version,
        stamp: expect.any(String),
        version: body.service.version
      });
      expect(body.service.memory).toMatchObject({
        array_buffers_bytes: expect.any(Number),
        external_bytes: expect.any(Number),
        heap_total_bytes: expect.any(Number),
        heap_used_bytes: expect.any(Number),
        rss_bytes: expect.any(Number)
      });
      expect(body.process_group_memory).toMatchObject({
        contract: "runner-process-group-memory.v1",
        freshness: { status: "unavailable" },
        budget: { auto_restart: false, status: "unavailable" }
      });
      expect(body.db.ok).toBe(true);
      expect(body.auth.enabled).toBe(true);
      expect(body.config.addr).toBe("127.0.0.1:3008");
      expect(body.config.auth_enabled).toBe(true);
      expect(body.config.db_path).toBe("<stateDir>/runner.db");
      expect(body.event_projection).toMatchObject({
        lag_rows: 0,
        last_event_id: 0,
        projected_row_count: 0,
        source_of_truth: "issue_events",
        status: "ready"
      });
      expect(body.run_progress_projection).toMatchObject({
        active_runs: 0,
        projection_mode: "read_through_rebuild",
        source_of_truth: "issue_runs+run_attempts+issue_events",
        stalled_runs: 0,
        status: "ready",
        waiting_approval_runs: 0
      });
      expect(body.observability).toMatchObject({
        schema_version: "xuanwu.runtime-observability.v1",
        query_contract: { raw_log_scan: false, provider_session_scan: false },
        dimensions: {
          work: { source: "issues", total: 0 },
          run: { source: "issue_runs", total: 0, attempts: 0 },
          automation: { source: "automation_runs", total: 0 }
        },
        trace_correlation: { trace_id_contract: "canonical Work id", items: [] }
      });
      expect(body.health).toMatchObject({ state: expect.any(String), reasons: expect.any(Array) });
      expect(body.codex).toMatchObject({
        command: "codex app-server --listen stdio://",
        command_ok: true,
        capability_summary: CODEX_CAPABILITIES.join(","),
        capabilities: CODEX_CAPABILITIES,
        app_server: "not_checked",
        model_list: "not_checked"
      });
      const codex = body.providers.find((provider) => provider.id === "codex");
      const claude = body.providers.find((provider) => provider.id === "claude");
      expect(codex).toMatchObject({
        id: "codex",
        label: "Codex",
        role: "executor",
        enabled: true,
        capabilities: CODEX_CAPABILITIES,
        command: "codex app-server --listen stdio://",
        cli: { command: "codex app-server --listen stdio://" },
        cwd_configured: false,
        env_keys: [],
        secrets: { api_key: { configured: false } },
        settings_mode: "runner_settings:cli",
        timeout_ms: 1_800_000,
        effective_rpc_timeout_ms: 90_000
      });
      expect(claude).toMatchObject({
        id: "claude",
        label: "Claude Agent SDK",
        role: "executor",
        enabled: true,
        capabilities: CLAUDE_CAPABILITIES,
        command: "bundled:@anthropic-ai/claude-agent-sdk",
        cli: { available: false, mode: "not_used" },
        cwd_configured: false,
        default_model: "",
        env_keys: [],
        mode: "sdk",
        ready: false,
        sdk: { executable_ready: true, installed: true, ready: false, version: CLAUDE_AGENT_SDK_VERSION },
        secrets: { api_key: { configured: false } },
        settings_mode: "runner_env_to_anthropic_sdk",
        status: "configuration_required",
        timeout_ms: 1_800_000
      });
      expect(body.providers.some((provider) => provider.id === "pi")).toBe(false);
      expect(body.connectors).toEqual([{
        id: "feishu",
        label: "Feishu IM",
        enabled: false,
        status: "disabled",
        settings_mode: "settings_page_or_local_config",
        receive_mode: "websocket",
        supported_events: ["message.text", "message.mention"],
        attachment_policy: "metadata_only",
        auto_reply: false,
        secrets: {
          app_id: { configured: false },
          app_secret: { configured: false },
          verification_token: { configured: false, optional: true },
          encrypt_key: { configured: false, optional: true }
        },
        allowed_chat_count: 0,
        allowed_user_count: 0,
        project_mapping_count: 0,
        missing_required: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
        summary: {
          callback_path: "/api/integrations/feishu/events",
          configured: false,
          error: "",
          public_url_required: false,
          receive_enabled: false,
          receive_mode: "websocket",
          reply_mode: "draft",
          state: "disabled"
        }
      }]);
      expect(body.connector_health.map((connector) => connector.id)).toEqual([
        "feishu", "telegram", "webhook", "github-events", "gitlab-events", "github-issues", "gitlab-issues", "linear-issues"
      ]);
      expect(body.connector_health[0]).toMatchObject({
        health: { state: "unconfigured" },
        permissions: expect.any(Array),
        secret_refs: expect.any(Array),
        test_connection: { supported: true }
      });
      expect(body.runner.running_loops).toBeGreaterThanOrEqual(0);
      expect(body.runner.auto_run_projects).toBe(0);
      expect(body.runner.in_progress_issues).toBe(0);
    });
  
  test("reports projection health from the active V2 reader", async () => {
      const { body, status } = await systemStatus({ claudeMode: "sdk" }, {
        route: { startedAt: new Date("2026-05-28T00:00:00.000Z") },
        seed: ({ database }) => {
          insertProject(database, "projection-status", { name: "Projection status", created_at: "2026-05-28T00:00:00.000Z", updated_at: "2026-05-28T00:00:00.000Z" });
          createIssue(database, { description: "Verify V2 projection status", project_id: "projection-status", title: "V2 status" });
          projectPendingCompactEventSummaries(database);
          updateEventSummaryProjectionSwitch(database, {
            cutover_at: "2026-05-28T00:00:01.000Z",
            expectedRevision: 0,
            observation_expires_at: "2026-05-28T00:00:01.000Z",
            observation_started_at: "2026-05-27T00:00:00.000Z",
            read_version: "v2",
            updatedAt: "2026-05-28T00:00:01.000Z"
          });
        }
      });
  
      expect(status).toBe(200);
      expect(body.event_projection).toMatchObject({
        projection_id: "issue_events_summary_v2",
        last_event_id: 1,
        lag_rows: 0,
        projected_row_count: 1,
        status: "ready"
      });
    });
}
