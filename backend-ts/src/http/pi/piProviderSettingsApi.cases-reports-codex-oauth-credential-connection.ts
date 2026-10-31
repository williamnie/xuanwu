import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piProviderSettingsApi.testFixture.ts";

export function registerReportsCodexOauthCredentialConnectionCases(testScope: TestFixture) {
  const { openFixtureDatabase, post, authPath } = testScope;
  test("reports Codex OAuth credential connection state without echoing OAuth tokens", async () => {
      const database = await openFixtureDatabase();
      const router = createDefaultRouter({
        database,
        piOpenAICodexModelDiscovery: async (activeDatabase) => {
          const raw = JSON.parse(await readFile(authPath(activeDatabase), "utf8"));
          expect(raw["openai-codex"]?.access).toBe("oauth-access-secret");
          return ["gpt-5.6", "gpt-5.5"];
        },
        providers: {
          codex: {
            id: "codex",
            capabilities: [],
            async listModels() {
              throw new Error("executor model discovery must not validate PI OAuth");
            },
            async run() {
              throw new Error("not used");
            }
          }
        }
      });
      const missing = await post(router, "/api/pi/provider-settings/openai-codex/test-connection", {});
      expect(await missing.json()).toMatchObject({
        auth: "oauth",
        error: "oauth_not_configured",
        ok: false,
        provider_id: "openai-codex"
      });
  
      const oauthAuthPath = join(dirname(database.path), "pi-runtime", "agent", "auth.json");
      await mkdir(dirname(oauthAuthPath), { recursive: true });
      await Bun.write(oauthAuthPath, JSON.stringify({
        "openai-codex": { type: "oauth", access: "oauth-access-secret", refresh: "oauth-refresh-secret", expires: Date.now() + 60_000 }
      }));
      const configured = await post(router, "/api/pi/provider-settings/openai-codex/test-connection", {});
      const body = await configured.json() as { models: string[]; [key: string]: unknown };
      expect(body).toMatchObject({ auth: "oauth", ok: true, provider_id: "openai-codex", status: "connected" });
      expect(body.models).toEqual(["gpt-5.6", "gpt-5.5"]);
      expect(JSON.stringify(body)).not.toContain("oauth-access-secret");
      const audits = database.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='provider_connection_tested' order by id"
      ).all();
      expect(JSON.stringify(audits)).not.toContain("oauth-access-secret");
      expect(JSON.stringify(audits)).not.toContain("oauth-refresh-secret");
    });
}
