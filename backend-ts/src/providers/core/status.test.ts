import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { createProviderRegistry, type ProviderFactory, type ProviderRuntimeConfig } from "./registry.ts";
import { statusFromRegistry, type ProviderStatusEntry } from "./status.ts";
import type { ProviderCapabilities } from "./manifest.ts";

function factoryWith(
  id: string,
  capabilities: ProviderCapabilities,
  instance: Record<string, unknown>,
  options?: {
    autoDetect?: () => { installed: boolean; ready: boolean; reason?: string };
    runtimeStatus?: () => Record<string, unknown>;
  }
): ProviderFactory {
  const manifest = {
    id: asProviderId(id),
    displayName: `Fake ${id}`,
    supportLevel: "tested" as const,
    transports: ["stdio-json"] as const,
    capabilities
  };
  return {
    manifest,
    parseConfig: (raw: unknown): ProviderRuntimeConfig => ({ ...(raw as Record<string, unknown>) }),
    autoDetect: options?.autoDetect ?? (() => ({ installed: true, ready: true })),
    create: () => ({
      ...instance,
      ...(options?.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {})
    }) as never
  };
}

async function registryWith(
  factories: Array<{ factory: ProviderFactory; disabled?: boolean }>
): Promise<ReturnType<typeof createProviderRegistry>> {
  const registry = createProviderRegistry();
  for (const { factory } of factories) registry.registerFactory(factory);
  const config: Record<string, ProviderRuntimeConfig | undefined> = {};
  for (const { factory, disabled } of factories) config[String(factory.manifest.id)] = disabled ? { enabled: false } : undefined;
  await registry.startConfigured(config);
  return registry;
}

describe("P4: 四种状态一致投影", () => {
  test("ready / not_ready（未安装未登录）/ failed（配置错误）/ disabled 一致出现", async () => {
    const registry = await registryWith([
      {
        factory: factoryWith("ready-provider", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
          runtimeStatus: () => ({ ready: true, version: "1.2.3", auth_source: "local-cli", active_sessions: 0, mode: "sdk" })
        })
      },
      {
        factory: factoryWith("uninstalled-provider", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
          autoDetect: () => ({ installed: false, ready: false, reason: "CLI not found" })
        })
      },
      {
        // 声明 sessions.create 但缺方法 → startup failed
        factory: factoryWith(
          "broken-provider",
          { issueExecution: true, sessions: { create: true } },
          { run: async () => ({ runId: "r" }) }
        )
      },
      {
        factory: factoryWith("off-provider", { issueExecution: true }, { run: async () => ({ runId: "r" }) }),
        disabled: true
      }
    ]);
    const status = statusFromRegistry(registry.list());
    const byId = new Map(status.map((s) => [s.id, s]));
    expect(byId.get("ready-provider")).toMatchObject({ state: "ready", ready: true, available: true, enabled: true });
    expect(byId.get("uninstalled-provider")).toMatchObject({ state: "not_ready", ready: false, available: false, enabled: true });
    expect(byId.get("broken-provider")).toMatchObject({ state: "failed", ready: false, available: false, enabled: true });
    expect(byId.get("broken-provider")?.failure?.category).toBe("capability_unsupported");
    expect(byId.get("off-provider")).toMatchObject({ state: "disabled", ready: false, available: false, enabled: false });
    // enabled/ready/supportLevel/authSource/runtimeVersion 分离
    expect(byId.get("ready-provider")?.supportLevel).toBe("tested");
    expect(byId.get("ready-provider")?.authSource).toBe("local-cli");
    expect(byId.get("ready-provider")?.runtimeVersion).toBe("1.2.3");
  });

  test("新测试 Provider 经 factory 出现在 status，不依赖 status builder switch", async () => {
    const registry = await registryWith([
      { factory: factoryWith("fake-execution-only", { issueExecution: true }, { run: async () => ({ runId: "r" }) }) },
      { factory: factoryWith("brand-new-adapter", { issueExecution: true }, { run: async () => ({ runId: "r" }) }) }
    ]);
    const ids = statusFromRegistry(registry.list()).map((s) => s.id).sort();
    // statusFromRegistry 不写死任何 provider ID（无 switch）——新增 ID 自然出现
    expect(ids).toEqual(["brand-new-adapter", "fake-execution-only"]);
  });
});

describe("P4: status 脱敏", () => {
  test("failure 诊断不含 token / 完整 credential path / URL userinfo/query", async () => {
    const registry = createProviderRegistry();
    // config 解析错误信息含敏感值 → failed + 脱敏
    const broken = factoryWith("leaky", { issueExecution: true }, { run: async () => ({ runId: "r" }) });
    broken.parseConfig = () => {
      throw new Error("config failed for /Users/alice/.claude/credentials.json with api_key=sk-live-AKIAIOSFODNN7EXAMPLE and https://user:secret@example.com/api?token=abc123");
    };
    registry.registerFactory(broken);
    await registry.startConfigured({});
    const status = statusFromRegistry(registry.list());
    const leaky = status.find((s) => s.id === "leaky");
    expect(leaky?.state).toBe("failed");
    const message = leaky?.failure?.message ?? "";
    expect(message).not.toContain("sk-live");
    expect(message).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(message).not.toContain("/Users/alice/.claude/credentials.json");
    expect(message).not.toContain("user:secret@");
    expect(message).not.toContain("token=abc123");
  });

  test("runtimeVersion/authSource 敏感路径与 query 被折叠", async () => {
    const registry = await registryWith([
      {
        factory: factoryWith("secretive", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
          runtimeStatus: () => ({
            ready: true,
            version: "/Users/alice/codex/bin 0.1.0?token=abc",
            auth_source: "local-cli",
            active_sessions: 0,
            mode: "sdk"
          })
        })
      }
    ]);
    const entry = statusFromRegistry(registry.list()).find((s) => s.id === "secretive");
    expect(entry?.runtimeVersion).not.toContain("/Users/alice");
    expect(entry?.runtimeVersion).not.toContain("token=abc");
  });

  test("投影结果不含任何敏感字段名", async () => {
    const registry = await registryWith([
      {
        factory: factoryWith("safe", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
          runtimeStatus: () => ({ ready: true, version: "1.0", auth_source: "runner-env", active_sessions: 0, mode: "cli" })
        })
      }
    ]);
    const json = JSON.stringify(statusFromRegistry(registry.list()));
    expect(json.toLowerCase()).not.toMatch(/api[_-]?key|token|password|secret/);
  });
});

export type { ProviderStatusEntry };
