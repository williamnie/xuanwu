import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "./registry.ts";
import { checkManifest } from "./conformance.ts";
import { compareCapabilitiesParity } from "./parity.ts";
import { codexFactory } from "../codex/factory.ts";
import { claudeFactory } from "../claude/factory.ts";
import { piFactory } from "../pi/factory.ts";
import { qoderFactory } from "../qoder/factory.ts";
import { createFakeQoderSdkFacade } from "../qoder/sdkFacade.ts";
import type { QoderRuntimeProbe } from "../qoder/runtime.ts";

/**
 * P12：删除门禁——至少 Codex、Claude、Pi、Qoder 四种形态通过 conformance。
 * 四种 factory 经 registry 装配，capability/method 一致、capabilities parity 无 drift。
 */

async function fourFormRegistry() {
  const registry = createProviderRegistry();
  registry.registerFactory(codexFactory({}));
  registry.registerFactory(claudeFactory({}));
  registry.registerFactory(piFactory({}));
  registry.registerFactory(qoderFactory({
    facade: createFakeQoderSdkFacade([]).facade,
    runtimeProbe: () => readyQoderProbe
  }));
  await registry.startConfigured({
    codex: { command: process.execPath },
    claude: { authMode: "environment", mode: "sdk", env: { ANTHROPIC_API_KEY: "test-key" } },
    "pi-coding-agent": { command: process.execPath },
    qoder: {}
  });
  return registry;
}

const readyQoderProbe: QoderRuntimeProbe = {
  installed: true,
  ready: true,
  status: {
    active_sessions: 0,
    api_key_configured: true,
    auth_configured: true,
    auth_mode: "pat-env",
    auth_source: "environment",
    executable_ready: true,
    mode: "sdk",
    ready: true,
    version: "1.0.23",
    platform_profile: {
      cli_version: "1.1.23",
      protocol_status: "expected",
      protocol_version: "1.2.0",
      sdk_ready: true,
      sdk_version: "1.0.23"
    }
  }
};

describe("P12: 四种形态 conformance（Codex/Claude/Pi/Qoder）", () => {
  test("四种 factory 全部 ready 且 capability/method 一致", async () => {
    const registry = await fourFormRegistry();
    const ids = registry.list().map((e) => String(e.id)).sort();
    expect(ids).toEqual(["claude", "codex", "pi-coding-agent", "qoder"]);
    for (const entry of registry.list()) {
      expect(entry.state).toBe("ready");
      expect(() => checkManifest(entry.manifest, entry.instance as unknown as Record<string, unknown>)).not.toThrow();
    }
  });

  test("四种形态 manifest ↔ 实例 capabilities 无 parity drift", async () => {
    const registry = await fourFormRegistry();
    for (const entry of registry.list()) {
      const report = compareCapabilitiesParity(entry);
      expect(report.ok).toBe(true);
    }
  });

  test("四种形态 support level 符合验收（Codex tested，其余 preview）", async () => {
    const registry = await fourFormRegistry();
    const byId = new Map(registry.list().map((e) => [String(e.id), e.manifest.supportLevel]));
    expect(byId.get("codex")).toBe("tested");
    expect(byId.get("claude")).toBe("preview");
    expect(byId.get("pi-coding-agent")).toBe("preview");
    expect(byId.get("qoder")).toBe("preview");
  });
});
