import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderExecutionRef } from "../types.ts";
import { createProviderRegistry } from "./registry.ts";
import { codexFactory } from "../codex/factory.ts";
import { claudeFactory } from "../claude/factory.ts";
import {
  aggregateParityReports,
  compareCapabilitiesParity,
  compareRefsParity,
  legacyProjectionCompareEnabled,
  summarizeConsumerInventory
} from "./parity.ts";

describe("P9: refs parity（canonical ↔ legacy projection 无 drift）", () => {
  test("Codex thread/turn 映射一致", () => {
    const canonical: Partial<ProviderExecutionRef> = { sessionRef: "thread-abc", messageRef: "turn-42" };
    const report = compareRefsParity("codex", canonical, { thread_id: "thread-abc", turn_id: "turn-42" });
    expect(report.ok).toBe(true);
    expect(report.diffs).toEqual([]);
  });

  test("execution-only 无 session ref → legacy 空字段一致", () => {
    const report = compareRefsParity("fake-execution-only", undefined, { thread_id: "", turn_id: "" });
    expect(report.ok).toBe(true);
  });

  test("drift 检测：canonical 与 legacy 不一致时报告字段级 diff", () => {
    const canonical: Partial<ProviderExecutionRef> = { sessionRef: "thread-new", messageRef: "turn-9" };
    const report = compareRefsParity("codex", canonical, { thread_id: "thread-old", turn_id: "turn-9" });
    expect(report.ok).toBe(false);
    expect(report.diffs).toContainEqual({ scope: "refs", field: "thread_id", canonical: "thread-new", legacy: "thread-old" });
  });
});

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

  test("consumer inventory 汇总（consumer-zero 目标）", () => {
    const summary = summarizeConsumerInventory([
      { consumer: "runtime/core.ts", status: "migrated" },
      { consumer: "http/sessionApi.ts", status: "legacy" },
      { consumer: "runner/projectLoop.ts", status: "migrated" }
    ]);
    expect(summary).toEqual({ migrated: 2, legacy: 1, total: 3 });
  });

  test("观察窗 flag 默认关闭（rollback 无 DB 回填）", () => {
    // 默认环境变量未设置 → false；显式开启 → true
    expect(legacyProjectionCompareEnabled()).toBe(false);
  });
});
