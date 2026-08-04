import { describe, expect, test } from "bun:test";
import { createDefaultRouter } from "./server.ts";
import { createProviderRegistry, type ProviderFactory } from "../providers/core/registry.ts";
import { asProviderId, type ExecutorProvider } from "../providers/types.ts";
import type { ProviderCapabilities } from "../providers/core/manifest.ts";

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
});
