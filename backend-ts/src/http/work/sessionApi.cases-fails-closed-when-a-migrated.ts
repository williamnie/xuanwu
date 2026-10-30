import { expect, test } from "bun:test";
import { claudeManifest } from "../../providers/claude/factory.ts";
import { providerSessionDetail } from "../../providers/core/sessionView.ts";
import type { TestFixture } from "./sessionApi.testFixture.ts";

export function registerFailsClosedWhenAMigratedCases(testScope: TestFixture) {
  const { sessionsFixture, ClaudeSessionsProvider } = testScope;
  test("fails closed when a migrated adapter leaks provider-native session data", async () => {
      const claude = Object.assign(new ClaudeSessionsProvider(), { manifest: claudeManifest() });
      const { api } = await sessionsFixture({ claude });
  
      expect(await api.get("/api/sessions?provider=claude")).toMatchObject({
        status: 200,
        body: { provider_errors: [{ provider: "claude", error: expect.stringContaining("invalid xw.provider-session.v1 view") }] }
      });
      const detail = await api.get("/api/sessions/claude:claude-existing");
      expect(detail.status).toBe(400);
      expect(JSON.stringify(detail.body)).toContain("invalid xw.provider-session.v1 view");
    });
  
  test("fails closed when a migrated adapter returns another Session detail", async () => {
      const claude = Object.assign(new ClaudeSessionsProvider(), {
        manifest: claudeManifest(),
        async readSession() {
          return providerSessionDetail("claude", { sessionRef: "claude-other", turns: [] });
        }
      });
      const { api } = await sessionsFixture({ claude });
  
      const detail = await api.get("/api/sessions/claude:claude-requested");
      expect(detail.status).toBe(400);
      expect(JSON.stringify(detail.body)).toContain("invalid xw.provider-session.v1 view");
    });
}
