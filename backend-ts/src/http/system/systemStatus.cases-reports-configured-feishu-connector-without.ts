import { expect, test } from "bun:test";
import type { TestFixture } from "./systemStatus.testFixture.ts";

export function registerReportsConfiguredFeishuConnectorWithoutCases(testScope: TestFixture) {
  const { systemStatus } = testScope;
  test("reports configured Feishu connector without leaking secrets", async () => {
      const secret = "fixture-status-secret";
      const { body, status, text } = await systemStatus({
        feishuAppId: "cli_app_id",
        feishuAppSecret: "app-secret-value",
        feishuEncryptKey: "encrypt-secret-value",
        feishuVerificationToken: "verify-secret-value",
        secret
      });
  
      expect(status).toBe(200);
      expect(body.connectors[0]).toMatchObject({
        id: "feishu",
        enabled: true,
        receive_mode: "websocket",
        status: "configured",
        missing_required: [],
        secrets: {
          app_id: { configured: true },
          app_secret: { configured: true },
          verification_token: { configured: true },
          encrypt_key: { configured: true, optional: true }
        },
        summary: {
          callback_path: "/api/integrations/feishu/events",
          configured: true,
          error: "",
          public_url_required: false,
          receive_enabled: true,
          receive_mode: "websocket",
          reply_mode: "draft",
          state: "configured"
        }
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("app-secret-value");
      expect(text).not.toContain("encrypt-secret-value");
      expect(text).not.toContain("verify-secret-value");
    });
  
  test("does not leak token or raw paths in status JSON", async () => {
      const secret = "fixture-status-secret";
      const { config, status, text } = await systemStatus({
        secret,
        claudeMode: "sdk",
        codexCommand: "codex --token=runtime-secret app-server --listen stdio://",
        codexEnv: "CODEX_API_KEY=runtime-secret,SAFE_VALUE=ok"
      });
  
      expect(status).toBe(200);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(config.stateDir);
      expect(text).not.toContain(config.dbPath);
      expect(text).not.toContain(config.authTokenFile);
      expect(text).not.toContain("auth_token");
      expect(text).not.toContain("runtime-secret");
      expect(text).not.toContain("CODEX_API_KEY");
      expect(text).toContain("SAFE_VALUE");
    });
}
