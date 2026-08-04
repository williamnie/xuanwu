import type { ExecutorProvider, ProviderExecutionRef } from "../types.ts";
import { legacySessionFields } from "./legacyProjection.ts";
import { legacyCapabilitiesFromDetail } from "./manifest.ts";
import type { RegistryEntry } from "./registry.ts";

/**
 * P9：Canonical projection 切换与兼容观察窗（设计 §4.3 W2）。
 * - parity metrics：canonical DTO 与 legacy DTO 字段级对比（refs/status/session_count/run control）；
 * - legacy consumer runtime warning：仍走 legacy 消费路径的清单；
 * - 开关：XUANWU_PROVIDER_LEGACY_PROJECTION_COMPARE=1 时运行对比并记录 drift。
 * - rollback 不需要 DB 回填或删除事件（只读对比）。
 */

export type ParityScope = "refs" | "capabilities" | "status";

export type ParityDiff = {
  scope: ParityScope;
  field: string;
  canonical: unknown;
  legacy: unknown;
};

export type ParityReport = {
  provider: string;
  ok: boolean;
  diffs: ParityDiff[];
};

/** P9：refs parity——canonical ProviderExecutionRef 经 legacyProjection 与 legacy 存储值对比。 */
export function compareRefsParity(
  provider: string,
  canonical: Partial<ProviderExecutionRef> | undefined,
  legacy: { thread_id: string; turn_id: string }
): ParityReport {
  const projected = legacySessionFields(canonical);
  const diffs: ParityDiff[] = [];
  for (const field of ["thread_id", "turn_id"] as const) {
    if (projected[field] !== legacy[field]) {
      diffs.push({ scope: "refs", field, canonical: projected[field], legacy: legacy[field] });
    }
  }
  return { provider, ok: diffs.length === 0, diffs };
}

/** P9：capabilities parity——manifest detail 投影 vs 实例 legacy 数组（drift 检测）。 */
export function compareCapabilitiesParity(entry: RegistryEntry): ParityReport {
  const manifestLegacy = [...legacyCapabilitiesFromDetail(entry.manifest.capabilities)].sort();
  const instanceLegacy = [...(entry.instance?.capabilities ?? [])] as string[];
  instanceLegacy.sort();
  const diffs: ParityDiff[] = [];
  for (const field of new Set([...manifestLegacy, ...instanceLegacy])) {
    if (manifestLegacy.includes(field) !== instanceLegacy.includes(field)) {
      diffs.push({
        scope: "capabilities",
        field,
        canonical: manifestLegacy.includes(field),
        legacy: instanceLegacy.includes(field)
      });
    }
  }
  return { provider: String(entry.id), ok: diffs.length === 0, diffs };
}

/** P9：W2 观察窗 flag（rollback 用；关闭即回退旧 projection，无 DB 回填）。 */
export function legacyProjectionCompareEnabled(): boolean {
  return process.env.XUANWU_PROVIDER_LEGACY_PROJECTION_COMPARE === "1";
}

/** P9：legacy consumer runtime warning——仍走 legacy 路径的消费点清单（consumer-zero 目标）。 */
export function legacyConsumerRuntimeWarning(consumedLegacyPaths: readonly string[]): string[] {
  return consumedLegacyPaths.filter((path) => path !== "");
}

export type LegacyConsumerInventory = Array<{ consumer: string; status: "migrated" | "legacy" | "pending" }>;

export function summarizeConsumerInventory(inventory: LegacyConsumerInventory): { migrated: number; legacy: number; total: number } {
  const migrated = inventory.filter((i) => i.status === "migrated").length;
  const legacy = inventory.filter((i) => i.status !== "migrated").length;
  return { migrated, legacy, total: inventory.length };
}

/** P9：run parity 报告聚合（供 runtime 在观察窗内记录）。 */
export function aggregateParityReports(reports: ParityReport[]): { ok: boolean; driftedProviders: string[]; diffs: number } {
  const drifted = reports.filter((r) => !r.ok);
  return {
    ok: drifted.length === 0,
    driftedProviders: drifted.map((r) => r.provider),
    diffs: drifted.reduce((acc, r) => acc + r.diffs.length, 0)
  };
}

export type { ExecutorProvider };
