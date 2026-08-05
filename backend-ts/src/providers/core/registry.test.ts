import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { checkManifest } from "./conformance.ts";
import { createProviderRegistry, type ProviderFactory, type ProviderRuntimeConfig } from "./registry.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "./manifest.ts";
import { BUILTIN_FACTORIES } from "../testing/conformanceFactories.ts";

/**
 * P2 fixture factory：按 manifest 与 instance 组装。
 * instance 由 caller 提供（可为缺方法的残缺对象）。
 */
function factoryOf(
  id: string,
  capabilities: ProviderCapabilities,
  instance: Record<string, unknown>,
  options?: {
    autoDetect?: () => { installed: boolean; ready: boolean; reason?: string };
    stop?: () => Promise<void> | void;
  }
): ProviderFactory {
  const manifest: ExecutorProviderManifest = {
    id: asProviderId(id),
    displayName: `fake ${id}`,
    supportLevel: "tested",
    transports: ["stdio-json"],
    capabilities
  };
  const withStop = options?.stop ? { ...instance, stop: options.stop } : instance;
  return {
    manifest,
    parseConfig: (raw: unknown): ProviderRuntimeConfig => ({ ...(raw as Record<string, unknown>) }),
    autoDetect: options?.autoDetect ?? (() => ({ installed: true, ready: true })),
    create: () => withStop as never
  };
}

const FULL_SESSION_CAPS: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, list: true, read: true, resume: true },
  control: { interrupt: true, approvals: "host-callback" },
  models: { list: true }
};

describe("P2: registry 注册与发现", () => {
  test("注册测试 Provider 后可发现，无需修改白名单（不依赖 EXECUTOR_PROVIDER_IDS）", async () => {
    const registry = createProviderRegistry();
    const instance = {
      id: "fake-execution-only",
      capabilities: ["issue_execution"],
      run: async () => ({ runId: "r1" })
    };
    registry.registerFactory(factoryOf("fake-execution-only", { issueExecution: true }, instance));

    const disposed = registry.injectFactoryForTest(
      factoryOf("ephemeral-provider", { issueExecution: true }, { id: "ephemeral-provider", capabilities: ["issue_execution"], run: async () => ({ runId: "r2" }) })
    );
    // 未启动时 state=registered（可列出）
    expect(registry.list().map((e) => String(e.id))).toContain("fake-execution-only");
    expect(registry.list().map((e) => String(e.id))).toContain("ephemeral-provider");

    await registry.startConfigured({});
    expect(String(registry.getReady(asProviderId("fake-execution-only")).id)).toBe("fake-execution-only");
    expect(String(registry.getReady(asProviderId("ephemeral-provider")).id)).toBe("ephemeral-provider");

    // 白名单未包含 ephemeral-provider，但仍可发现 → 无需修改白名单
    expect(registry.describe(asProviderId("ephemeral-provider")).state).toBe("ready");

    disposed.dispose();
    expect(registry.list().map((e) => String(e.id))).not.toContain("ephemeral-provider");
  });

  test("readyProviders 只投影 ready 实例，process lease 保留 Provider 归属", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(factoryOf("leased-provider", { issueExecution: true }, {
      id: "leased-provider",
      capabilities: ["issue_execution"],
      run: async () => ({ runId: "r" }),
      processLeases: () => [{
        commandLabel: "leased cli",
        invocationOwner: "issue:1",
        pid: 321,
        startedAt: "2026-08-04T00:00:00.000Z"
      }]
    }));
    registry.registerFactory(factoryOf("disabled-provider", { issueExecution: true }, {
      id: "disabled-provider",
      capabilities: ["issue_execution"],
      run: async () => ({ runId: "off" })
    }));
    await registry.startConfigured({ "disabled-provider": { enabled: false } });

    expect(Object.keys(registry.readyProviders())).toEqual(["leased-provider"]);
    expect(registry.collectProcessLeases()).toEqual([{
      commandLabel: "leased cli",
      invocationOwner: "issue:1",
      pid: 321,
      provider: asProviderId("leased-provider"),
      startedAt: "2026-08-04T00:00:00.000Z"
    }]);
  });

  test("duplicate ID 注册 fail closed", () => {
    const registry = createProviderRegistry();
    const f = factoryOf("codex", { issueExecution: true }, { run: async () => ({ runId: "r" }) });
    registry.registerFactory(f);
    expect(() => registry.registerFactory(f)).toThrow(/already registered/);
  });

  test("invalid ID（冒号/非法字符）注册 fail closed", () => {
    const registry = createProviderRegistry();
    expect(() => registry.registerFactory(factoryOf("bad:id", { issueExecution: true }, {}))).toThrow();
    expect(() => registry.registerFactory(factoryOf("", { issueExecution: true }, {}))).toThrow();
    expect(() => registry.registerFactory(factoryOf("Codex", { issueExecution: true }, {}))).toThrow();
  });

  test("未注册 ID getReady/describe fail closed", async () => {
    const registry = createProviderRegistry();
    await registry.startConfigured({});
    expect(() => registry.getReady(asProviderId("nope"))).toThrow(/not registered/);
    expect(() => registry.describe(asProviderId("nope"))).toThrow(/not registered/);
  });
});

describe("P2: conformance 校验（fail closed）", () => {
  test("声明 capability 但缺方法 → 启动 failed 且诊断脱敏", async () => {
    const registry = createProviderRegistry();
    // manifest 声明 sessions.create/list/read/resume + control + models，但实例只实现 run
    registry.registerFactory(
      factoryOf(
        "broken-provider",
        FULL_SESSION_CAPS,
        { id: "broken-provider", capabilities: ["issue_execution"], run: async () => ({ runId: "r" }) },
        { autoDetect: () => ({ installed: true, ready: true }) }
      )
    );
    await registry.startConfigured({});
    const entry = registry.describe(asProviderId("broken-provider"));
    expect(entry.state).toBe("failed");
    expect(entry.failure?.category).toBe("capability_unsupported");
    // 诊断含 capability/method 名，不含配置值/路径/token
    expect(entry.failure?.message).toContain("sessions.create");
    expect(entry.failure?.message).toContain("createSession");
    expect(entry.failure?.message).toContain("resolveApproval");
    expect(entry.failure?.message).not.toMatch(/secret|token|password|api[_-]?key/i);
    // fail closed：getReady 抛错
    expect(() => registry.getReady(asProviderId("broken-provider"))).toThrow(/not ready/);
  });

  test("checkManifest 单元：声明 false 的方法存在不曝光、也不报错", () => {
    // control.interrupt 未声明但实例实现了 interrupt → 校验通过（不自动曝光）
    const manifest: ExecutorProviderManifest = {
      id: asProviderId("silent"),
      displayName: "silent",
      supportLevel: "experimental",
      transports: [],
      capabilities: { issueExecution: true, sessions: { resume: true } }
    };
    expect(() => checkManifest(manifest, { run: async () => ({}), recover: async () => ({}) })).not.toThrow();
  });

  test("parseConfig 抛错 → failed + config_invalid", async () => {
    const registry = createProviderRegistry();
    const factory = factoryOf("bad-config", { issueExecution: true }, { run: async () => ({ runId: "r" }) });
    factory.parseConfig = () => {
      throw new Error("cannot parse config");
    };
    registry.registerFactory(factory);
    await registry.startConfigured({});
    expect(registry.describe(asProviderId("bad-config")).state).toBe("failed");
  });
});

describe("P2: startConfigured 状态机", () => {
  test("enabled=false → disabled，getReady fail closed", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(factoryOf("off-provider", { issueExecution: true }, { run: async () => ({ runId: "r" }) }));
    await registry.startConfigured({ "off-provider": { enabled: false } });
    const entry = registry.describe(asProviderId("off-provider"));
    expect(entry.state).toBe("disabled");
    expect(() => registry.getReady(asProviderId("off-provider"))).toThrow(/disabled/);
  });

  test("autoDetect 未安装 → not_ready，catalog 仍可见", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(
      factoryOf("uninstalled-provider", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
        autoDetect: () => ({ installed: false, ready: false, reason: "CLI not found" })
      })
    );
    await registry.startConfigured({});
    const entry = registry.describe(asProviderId("uninstalled-provider"));
    expect(entry.state).toBe("not_ready");
    expect(registry.list().map((e) => String(e.id))).toContain("uninstalled-provider");
    expect(() => registry.getReady(asProviderId("uninstalled-provider"))).toThrow(/not ready/);
  });
});

describe("P2: stopAll 有界容错", () => {
  test("单个 provider stop 失败不阻塞其余，失败方有独立 failure", async () => {
    const registry = createProviderRegistry();
    const stops: string[] = [];
    registry.registerFactory(
      factoryOf("stopper-ok", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
        stop: async () => {
          stops.push("stopper-ok");
        }
      })
    );
    registry.registerFactory(
      factoryOf("stopper-bad", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
        stop: async () => {
          stops.push("stopper-bad");
          throw new Error("stop exploded");
        }
      })
    );
    registry.registerFactory(
      factoryOf("stopper-noop", { issueExecution: true }, { run: async () => ({ runId: "r" }) }, {
        stop: async () => {
          stops.push("stopper-noop");
        }
      })
    );
    await registry.startConfigured({});
    await registry.stopAll();
    expect(stops).toContain("stopper-ok");
    expect(stops).toContain("stopper-bad");
    expect(stops).toContain("stopper-noop");
    const bad = registry.describe(asProviderId("stopper-bad"));
    expect(bad.state).toBe("failed");
    expect(bad.failure?.category).toBe("stop_failed");
    const ok = registry.describe(asProviderId("stopper-ok"));
    expect(ok.state).toBe("stopped");
    // stopAll 幂等：再次调用不重复 stop 失败 provider 的异常传播
    await expect(registry.stopAll()).resolves.toBeUndefined();
  });

  test("无 stop 方法的 provider 在 stopAll 中被跳过", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(factoryOf("no-stop", { issueExecution: true }, { run: async () => ({ runId: "r" }) }));
    await registry.startConfigured({});
    await expect(registry.stopAll()).resolves.toBeUndefined();
    expect(registry.describe(asProviderId("no-stop")).state).toBe("ready");
  });
});

describe("P2: 编译期内置 factory 集成", () => {
  test("BUILTIN_FACTORIES 注册后全部可发现并可运行（无需白名单修改）", async () => {
    const registry = createProviderRegistry();
    for (const f of BUILTIN_FACTORIES) registry.registerFactory(f);
    await registry.startConfigured({});
    const ids = registry.list().map((e) => String(e.id)).sort();
    expect(ids).toEqual(["fake-execution-only", "fake-full-session", "fake-resumable"]);
    // 三个均 ready（fixture autoDetect 恒 installed+ready）
    for (const id of ids) expect(registry.describe(asProviderId(id)).state).toBe("ready");
    // 真实 fixture 可经 registry 运行：execution-only 返回无 session result
    const instance = registry.getReady(asProviderId("fake-execution-only"));
    const result = await instance.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: () => {} });
    expect(result.session).toBeUndefined();
    // full-session fixture 的 session 方法经 registry 可发现（capability 投影出的方法存在）
    const full = registry.getReady(asProviderId("fake-full-session"));
    expect(typeof full.listSessions).toBe("function");
  });
});
