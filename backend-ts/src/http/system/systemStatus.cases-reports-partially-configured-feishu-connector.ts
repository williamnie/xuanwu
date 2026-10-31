import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_VERSION } from "../../providers/claude/provider.ts";
import type { TestFixture } from "./systemStatus.testFixture.ts";

export function registerReportsPartiallyConfiguredFeishuConnectorCases(testScope: TestFixture) {
  const { tempDir, CODEX_CAPABILITIES, CLAUDE_CAPABILITIES, systemStatus, writeFakeExecutable, insertRunnerStatusFixture } = testScope;
  test("reports partially configured Feishu connector as error summary", async () => {
      const { body, status } = await systemStatus({ feishuAppId: "cli_app_id" });
  
      expect(status).toBe(200);
      expect(body.connectors[0]).toMatchObject({
        enabled: false,
        id: "feishu",
        status: "misconfigured",
        summary: {
          configured: false,
          error: "missing FEISHU_APP_SECRET",
          public_url_required: false,
          receive_enabled: false,
          receive_mode: "websocket",
          reply_mode: "draft",
          state: "error"
        }
      });
    });
  
  test("an unprobed Telegram connector does not report a service outage", async () => {
      const { body } = await systemStatus({ telegramBotToken: "123456:fixture-token" }, {
        seed: ({ config }) => {
          config.integrations.telegram.allowedChatIds = ["1"];
          config.integrations.telegram.allowedUserIds = ["2"];
        }
      });
      expect(body.connector_health.find(connector => connector.id === "telegram"))
        .toMatchObject({ enabled: true, health: { checked: false, state: "unknown" } });
      expect((body.health as { reasons?: Array<{ source_ref?: string }> }).reasons ?? [])
        .not.toContainEqual(expect.objectContaining({ source_ref: "connector:telegram" }));
    });
  
  test("uses the live Feishu websocket receiver as connector health authority", async () => {
      const { body, status } = await systemStatus({ feishuAppId: "cli_app_id", feishuAppSecret: "cli_app_secret" }, {
        route: {
          feishuReceiverStatus: () => ({
            connected: true,
            last_error: "",
            last_event_at: "2026-07-23T12:00:00Z",
            receive_mode: "websocket",
            reconnect_attempts: 0,
            state: "connected"
          })
        }
      });
      const feishu = body.connector_health.find((connector) => connector.id === "feishu");
  
      expect(status).toBe(200);
      expect(feishu).toMatchObject({
        health: {
          checked: true,
          last_sync_at: "2026-07-23T12:00:00Z",
          state: "healthy"
        },
        runtime: { connected: true, state: "connected" }
      });
      expect((body.health as { reasons?: Array<{ source_ref?: string }> }).reasons ?? [])
        .not.toContainEqual(expect.objectContaining({ source_ref: "connector:feishu" }));
    });
  
  test("reports runner counts from database state", async () => {
      const { body, status } = await systemStatus({}, { seed: ({ database }) => insertRunnerStatusFixture(database) });
  
      expect(status).toBe(200);
      expect(body.runner).toMatchObject({
        auto_run_projects: 1,
        held_projects: 1,
        in_progress_issues: 1,
        running_issues: 1,
        running_sessions: 1
      });
    });
  
  test("reports configured Claude SDK metadata without leaking env secrets", async () => {
      const binDir = await tempDir();
      await writeFakeExecutable(binDir, "claude", "claude 2.1.114 (Claude Code)");
      const secret = "anthropic-status-secret";
      const { body, status, text } = await systemStatus({
        claudeCommand: "claude",
        claudeEnv: `PATH=${binDir},ANTHROPIC_API_KEY=${secret},SAFE_CLAUDE=ok`,
        claudeApiBaseUrl: "https://gateway.example/private/tenant",
        claudeModel: "claude-sonnet-4-5"
      });
      const claude = body.providers.find((provider) => provider.id === "claude");
      const codex = body.providers.find((provider) => provider.id === "codex");
  
      expect(status).toBe(200);
      expect(claude).toMatchObject({
        id: "claude",
        status: "available",
        available: true,
        capabilities: CLAUDE_CAPABILITIES,
        command: "bundled:@anthropic-ai/claude-agent-sdk",
        cli: { available: false, mode: "not_used" },
        default_model: "claude-sonnet-4-5",
        env_keys: ["ANTHROPIC_BASE_URL", "PATH", "SAFE_CLAUDE"],
        mode: "sdk",
        ready: true,
        api_base_url_summary: "https://gateway.example/…",
        sdk: { executable_ready: true, installed: true, ready: true, version: CLAUDE_AGENT_SDK_VERSION },
        secrets: { api_key: { configured: true } }
      });
      expect(codex?.capabilities).toEqual(CODEX_CAPABILITIES);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("ANTHROPIC_API_KEY");
      expect(text).not.toContain("/private/tenant");
    });
  
  test("reports an Anthropic platform OAuth profile without exposing its credential contents", async () => {
      const profileRoot = await tempDir();
      await mkdir(join(profileRoot, "configs"), { recursive: true });
      await mkdir(join(profileRoot, "credentials"), { recursive: true });
      await writeFile(join(profileRoot, "configs", "runner.json"), JSON.stringify({
        version: "1.0",
        authentication: { type: "user_oauth" }
      }));
      const credentialPath = join(profileRoot, "credentials", "runner.json");
      await writeFile(credentialPath, JSON.stringify({ refresh_token: "profile-refresh-secret", version: "1.0" }));
      await chmod(credentialPath, 0o600);
      const { body, text } = await systemStatus({
        claudeAuthMode: "platform-profile",
        claudePlatformConfigDir: profileRoot,
        claudePlatformProfile: "runner"
      });
      const claude = body.providers.find((provider) => provider.id === "claude");
  
      expect(claude).toMatchObject({
        auth_configured: true,
        auth_mode: "platform-profile",
        auth_source: "platform_profile",
        ready: true,
        settings_mode: "anthropic_platform_profile",
        status: "available",
        platform_profile: {
          auth_type: "user_oauth",
          credentials_file_ready: true,
          profile: "runner"
        }
      });
      expect(text).not.toContain(profileRoot);
      expect(text).not.toContain("profile-refresh-secret");
    });
  
  test("reports local Claude CLI login as an explicit fallback auth source", async () => {
      const binDir = await tempDir();
      await writeFakeExecutable(binDir, "claude", "claude 2.1.170", true);
      const { body } = await systemStatus({
        claudeAuthMode: "local-cli",
        claudeCommand: join(binDir, "claude"),
        claudeMode: "cli-fallback"
      });
      const claude = body.providers.find((provider) => provider.id === "claude");
  
      expect(claude).toMatchObject({
        auth_configured: true,
        auth_mode: "local-cli",
        auth_source: "local_cli",
        available: true,
        capabilities: CLAUDE_CAPABILITIES,
        local_cli: { checked: true, logged_in: true },
        mode: "cli-fallback",
        ready: true,
        status: "available"
      });
    });
  
  test("returns doctor provider metadata for missing Claude without leaking secrets", async () => {
      const secret = "fixture-doctor-secret";
      const { body, status, text } = await systemStatus({
        secret,
        claudeCommand: "missing-claude-for-test",
        claudeEnv: "ANTHROPIC_API_KEY=doctor-secret",
        claudeMode: "cli-fallback"
      }, { path: "/api/system/doctor" });
      const claude = body.providers.find((provider) => provider.id === "claude");
  
      expect(status).toBe(200);
      expect(body.listen.addr).toBe("127.0.0.1:3008");
      expect(body.db.path).toBe("<stateDir>/runner.db");
      expect(body.observability).toMatchObject({
        schema_version: "xuanwu.runtime-observability.v1",
        query_contract: { raw_log_scan: false }
      });
      expect(body.health).toMatchObject({ state: expect.any(String), reasons: expect.any(Array) });
      expect(claude).toMatchObject({
        id: "claude",
        label: "Claude Code",
        status: "missing",
        available: false,
        enabled: true,
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt"]
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("doctor-secret");
      expect(text).not.toContain("ANTHROPIC_API_KEY");
    });
}
