import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "./registry.ts";
import { checkManifest } from "./conformance.ts";
import { compareCapabilitiesParity } from "./parity.ts";
import { codexFactory } from "../codex/factory.ts";
import { claudeFactory } from "../claude/factory.ts";
import { piFactory } from "../pi/factory.ts";
import { qoderFactory } from "../qoder/factory.ts";
import { createFakeQoderSdkFacade } from "../qoder/sdkFacade.ts";

/**
 * P12：删除门禁——至少 Codex、Claude、Pi、Qoder 四种形态通过 conformance。
 * 四种 factory 经 registry 装配，capability/method 一致、capabilities parity 无 drift。
 */

async function fourFormRegistry() {
  const registry = createProviderRegistry();
  registry.registerFactory(codexFactory({}));
  registry.registerFactory(claudeFactory({}));
  registry.registerFactory(piFactory({}));
  registry.registerFactory(qoderFactory({ facade: createFakeQoderSdkFacade([]).facade }));
  await registry.startConfigured({
    codex: { command: "codex" },
    claude: { mode: "sdk", env: {} },
    pi: { command: "pi" },
    qoder: {}
  });
  return registry;
}

describe("P12: 四种形态 conformance（Codex/Claude/Pi/Qoder）", () => {
  test("四种 factory 全部 ready 且 capability/method 一致", async () => {
    const registry = await fourFormRegistry();
    const ids = registry.list().map((e) => String(e.id)).sort();
    expect(ids).toEqual(["claude", "codex", "pi", "qoder"]);
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
    expect(byId.get("pi")).toBe("preview");
    expect(byId.get("qoder")).toBe("preview");
  });
});
