import { describe, expect, test } from "bun:test";
import {
  ENDURANCE_MINIMUM_DURATION_MS,
  ENDURANCE_REQUIRED_OPERATIONS,
  evaluateEnduranceGate,
  type EnduranceOperation,
  type EnduranceSample
} from "./enduranceGate.ts";

describe("24 hour runner endurance gate", () => {
  test("requires the real duration, lifecycle operations, bounded growth, and non-monotonic memory", () => {
    const start = Date.parse("2026-07-20T00:00:00Z");
    const operations: EnduranceOperation[] = ["idle", ...ENDURANCE_REQUIRED_OPERATIONS];
    const samples = Array.from({ length: 25 }, (_, index): EnduranceSample => ({
      application_support_bytes: 2_500_000_000 + index * 1000,
      artifact_bytes: 100_000_000 + index * 20_000,
      budget_status: "within_budget",
      completed_runs: 100 + index,
      database_bytes: 350_000_000 + index * 40_000,
      measured_group_bytes: (250 + index % 3) * 1024 * 1024,
      measured_main_bytes: 180 * 1024 * 1024,
      measurement_source: "footprint",
      observed_at: new Date(start + index * 60 * 60 * 1000).toISOString(),
      operation: operations[index % operations.length]!,
      orphan_processes: 0,
      stale_sessions: 0
    }));

    expect(evaluateEnduranceGate(samples)).toMatchObject({
      application_support: { status: "passed" },
      growth: { completed_runs: 24, status: "passed" },
      lifecycle: { missing_operations: [], status: "passed" },
      memory: { monotonic_growth: false, status: "passed" },
      sampling: { duration_ms: ENDURANCE_MINIMUM_DURATION_MS, samples: 25, status: "passed" },
      status: "passed"
    });
  });

  test("fails a report-only short soak even when individual samples look healthy", () => {
    const start = Date.parse("2026-07-20T00:00:00Z");
    const samples: EnduranceSample[] = [0, 1].map((hour) => ({
      application_support_bytes: 2_000_000_000,
      artifact_bytes: 10_000_000,
      budget_status: "within_budget",
      completed_runs: 1 + hour,
      database_bytes: 300_000_000,
      measured_group_bytes: (250 + hour) * 1024 * 1024,
      measured_main_bytes: 180 * 1024 * 1024,
      measurement_source: "footprint",
      observed_at: new Date(start + hour * 60 * 60 * 1000).toISOString(),
      operation: hour === 0 ? "idle" : "usage",
      orphan_processes: 0,
      stale_sessions: 0
    }));
    expect(evaluateEnduranceGate(samples)).toMatchObject({
      sampling: { status: "failed" },
      lifecycle: { status: "failed" },
      status: "failed"
    });
  });
});
