import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { createProviderRegistry } from "./registry.ts";
import { codexFactory } from "../codex/factory.ts";
import { claudeFactory } from "../claude/factory.ts";
import {
  aggregateParityReports,
  compareCapabilitiesParity,
  legacyProjectionCompareEnabled
} from "./parity.ts";

describe("P9: capabilities parity（manifest detail ↔ 实例 legacy 数组）", () => {
  test("Codex factory 注册后 manifest 与实例 capabilities 无 drift", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(codexFactory({}));
    await registry.startConfigured({ codex: { command: process.execPath } });
    const report = compareCapabilitiesParity(registry.describe(asProviderId("codex")));
    expect(report.ok).toBe(true);
  });

  test("Claude factory 注册后 manifest 与实例 capabilities 无 drift（无 approvals/model_list）", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(claudeFactory({}));
    await registry.startConfigured({ claude: { mode: "sdk", env: {} } });
    const report = compareCapabilitiesParity(registry.describe(asProviderId("claude")));
    expect(report.ok).toBe(true);
  });
});

describe("P9: W2 观察窗与 consumer-zero", () => {
  test("parity 报告聚合", () => {
    const reports = [
      { provider: "codex", ok: true, diffs: [] },
      { provider: "claude", ok: false, diffs: [{ scope: "refs" as const, field: "turn_id", canonical: "a", legacy: "b" }] }
    ];
    const aggregated = aggregateParityReports(reports);
    expect(aggregated.ok).toBe(false);
    expect(aggregated.driftedProviders).toEqual(["claude"]);
    expect(aggregated.diffs).toBe(1);
  });

  test("观察窗 flag 默认关闭（rollback 无 DB 回填）", () => {
    // 默认环境变量未设置 → false；显式开启 → true
    expect(legacyProjectionCompareEnabled()).toBe(false);
  });
});
