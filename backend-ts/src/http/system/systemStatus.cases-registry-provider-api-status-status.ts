import { expect, test } from "bun:test";
import { createDefaultRouter, registerSystemStatusRoute } from "../server.ts";
import { createProviderRegistry } from "../../providers/core/registry.ts";
import { asProviderId } from "../../providers/types.ts";
import type { TestFixture, StatusBody } from "./systemStatus.testFixture.ts";

export function registerRegistryProviderApiStatusStatusCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureRuntime } = testScope;
  test("registry 注册的测试 Provider 出现在 API status，无需修改 status builder switch", async () => {
      const { config, database } = await openFixtureRuntime({ claudeMode: "sdk" });
      const registry = createProviderRegistry();
      registry.registerFactory({
        manifest: {
          id: asProviderId("fake-execution-only"),
          displayName: "Fake Execution-Only",
          supportLevel: "tested",
          transports: ["stdio-json"],
          capabilities: { issueExecution: true }
        },
        parseConfig: (raw: unknown) => ({ ...(raw as Record<string, unknown>) }),
        autoDetect: () => ({ installed: true, ready: true }),
        create: () => ({ id: "fake-execution-only", capabilities: ["issue_execution"], run: async () => ({ runId: "r" }) }) as never
      });
      await registry.startConfigured({});
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, {
        authToken: "status-secret",
        config,
        database,
        providersRegistry: registry
      });
      const response = await router.handle(new Request(`${BASE_URL}/api/system/status`));
      expect(response.status).toBe(200);
      const body = (await response.json()) as StatusBody;
      const fake = body.providers.find((p) => p.id === "fake-execution-only");
      expect(fake).toBeDefined();
      expect(fake?.registry_state).toBe("ready");
      expect(fake?.support_level).toBe("tested");
      expect(fake?.capabilities).toContain("issue_execution");
      expect(body.providers.map((provider) => provider.id)).toEqual(["fake-execution-only"]);
  
      const compactResponse = await router.handle(new Request(`${BASE_URL}/api/system/status?compact=1`));
      expect(compactResponse.status).toBe(200);
      const compactBody = (await compactResponse.json()) as StatusBody;
      expect(compactBody.providers.map((provider) => provider.id)).toEqual(["fake-execution-only"]);
    });
}
