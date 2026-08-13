import { describe, expect, test } from "bun:test";
import { createDefaultRouter } from "./server.ts";
import { createProviderRegistry, type ProviderFactory } from "../providers/core/registry.ts";
import { asProviderId, type ExecutorProvider } from "../providers/types.ts";
import type { ProviderCapabilities } from "../providers/core/manifest.ts";
import { claudeManifest } from "../providers/claude/factory.ts";
import { claudeExecutionPolicyAdapter } from "../providers/claude/executionPolicy.ts";

function factoryFor(
  id: string,
  capabilities: ProviderCapabilities,
  instance: ExecutorProvider,
  options?: { installed?: boolean; displayName?: string }
): ProviderFactory {
  return {
    manifest: {
      id: asProviderId(id),
      displayName: options?.displayName ?? `Fake ${id}`,
      supportLevel: "preview",
      transports: ["stdio-json"],
      capabilities,
      executionSettings: { settings: [{ kind: "boolean", key: "verbose", label: "Verbose" }] }
    },
    parseConfig: (raw: unknown) => ({ ...(raw as Record<string, unknown>) }),
    autoDetect: () => ({ installed: options?.installed ?? true, ready: options?.installed ?? true }),
    create: () => instance as never
  };
}

async function catalogBody(router: ReturnType<typeof createDefaultRouter>) {
  const response = await router.handle(new Request("http://127.0.0.1/api/providers"));
  expect(response.status).toBe(200);
  return (await response.json()) as Array<Record<string, unknown>>;
}

describe("P6: /api/providers discovery catalog", () => {
  test("动态 fake Provider 无前端改动即出现在 catalog", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(
      factoryFor("fake-execution-only", { issueExecution: true }, {
        id: "fake-execution-only",
        capabilities: ["issue_execution"],
        run: async () => ({ runId: "r" })
      } as never)
    );
    registry.registerFactory(
      factoryFor("fake-full-session", {
        issueExecution: true,
        sessions: { create: true, resume: true },
        control: { interrupt: true }
      }, {
        id: "fake-full-session",
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt"],
        run: async () => ({ runId: "r" }),
        createSession: async () => ({ id: "s", provider: "fake-full-session", provider_session_id: "s", thread_id: "s", turn_id: undefined }),
        recover: async () => ({ runId: "r2", session: { provider: "fake-full-session", sessionId: "s" } }),
        interrupt: async () => {}
      } as never)
    );
    await registry.startConfigured({});
    const router = createDefaultRouter({ providersRegistry: registry });
    const catalog = await catalogBody(router);
    const ids = catalog.map((c) => c.id).sort();
    expect(ids).toEqual(["fake-execution-only", "fake-full-session"]);
    const full = catalog.find((c) => c.id === "fake-full-session")!;
    expect(full.label).toBe("Fake fake-full-session");
    expect(full.submittable).toBe(true);
    // session actions 由 capability 投影
    expect(full.session_actions).toEqual(expect.arrayContaining(["create", "resume", "interrupt"]));
  });

  test("execution-only Provider 不显示 Session action", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(
      factoryFor("fake-execution-only", { issueExecution: true }, {
        id: "fake-execution-only",
        capabilities: ["issue_execution"],
        run: async () => ({ runId: "r" })
      } as never)
    );
    await registry.startConfigured({});
    const router = createDefaultRouter({ providersRegistry: registry });
    const catalog = await catalogBody(router);
    expect(catalog[0].session_actions).toEqual([]);
  });

  test("model_list Provider 通过通用 catalog 路由返回模型", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(
      factoryFor("model-provider", { issueExecution: true, models: { list: true } }, {
        id: "model-provider",
        capabilities: ["issue_execution", "model_list"],
        run: async () => ({ runId: "r" }),
        listModels: async () => [{ id: "model-1" }]
      } as never)
    );
    await registry.startConfigured({});
    const router = createDefaultRouter({ providersRegistry: registry });
    const response = await router.handle(new Request("http://127.0.0.1/api/providers/model-provider/models"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "model-1" }] });
  });

  test("not-ready Provider 可见但 submittable=false（不可提交）", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(
      factoryFor("uninstalled", { issueExecution: true }, {
        id: "uninstalled",
        capabilities: ["issue_execution"],
        run: async () => ({ runId: "r" })
      } as never, { installed: false })
    );
    await registry.startConfigured({});
    const router = createDefaultRouter({ providersRegistry: registry });
    const catalog = await catalogBody(router);
    expect(catalog[0].id).toBe("uninstalled");
    expect(catalog[0].state).toBe("not_ready");
    expect(catalog[0].submittable).toBe(false);
  });

  test("readiness_reason 对外输出前脱敏", async () => {
    const registry = createProviderRegistry();
    const factory = factoryFor("secretive", { issueExecution: true }, {
      id: "secretive",
      capabilities: ["issue_execution"],
      run: async () => ({ runId: "r" })
    } as never);
    factory.create = () => {
      throw new Error("token=secret-value credential /Users/private/credentials.json");
    };
    registry.registerFactory(factory);
    await registry.startConfigured({});
    const catalog = await catalogBody(createDefaultRouter({ providersRegistry: registry }));
    expect(JSON.stringify(catalog)).not.toContain("secret-value");
    expect(JSON.stringify(catalog)).not.toContain("/Users/private/credentials.json");
  });

  test("未注册 Provider 的单项查询 404（不进入可提交 selector）", async () => {
    const registry = createProviderRegistry();
    const router = createDefaultRouter({ providersRegistry: registry });
    const response = await router.handle(new Request("http://127.0.0.1/api/providers/opencode"));
    expect(response.status).toBe(404);
  });

  test("无 registry 时 catalog 为空数组（兼容）", async () => {
    const router = createDefaultRouter();
    expect(await catalogBody(router)).toEqual([]);
  });

  test("execution policy resolve reflects the active Claude CLI transport", async () => {
    const registry = createProviderRegistry();
    const manifest = { ...claudeManifest(), capabilities: { issueExecution: true } };
    registry.registerFactory({
      manifest,
      parseConfig: () => ({}),
      autoDetect: () => ({ installed: true, ready: true }),
      create: () => ({
        id: "claude",
        capabilities: ["issue_execution"],
        manifest,
        policyAdapter: claudeExecutionPolicyAdapter,
        run: async () => ({ runId: "unused" }),
        runtimeStatus: () => ({ active_sessions: 0, api_key_configured: false, mode: "cli-fallback", ready: true, version: "2.1.221" })
      } as never)
    });
    await registry.startConfigured({});
    const router = createDefaultRouter({ providersRegistry: registry });
    const response = await router.handle(new Request("http://127.0.0.1/api/providers/claude/execution-policy/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        policy: {
          contract: "xw.execution-policy.v1",
          access: "provider-native-development",
          approval: "ask-sensitive"
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alternatives: expect.arrayContaining([
        { access: "read-only", approval: "unattended" },
        { access: "unrestricted-host", approval: "unattended" }
      ]),
      code: "policy_combination_unsupported",
      supported: false,
      reason: expect.stringContaining("cannot provide the required host approval")
    });
  });
});
