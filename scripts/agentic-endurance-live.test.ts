import { describe, expect, test } from "bun:test";
import { analyzeEndurance } from "./agentic-endurance-live.ts";

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-07-25T00:00:00.000Z");

describe("Issue 785 deterministic endurance reporter", () => {
  test("separates first failures from final failures and accepts a real 24h window", () => {
    const samples = Array.from({ length: 73 }, (_, slot) => sample(slot));
    const analysis = analyzeEndurance({
      samples,
      state: state(),
      timeline: [
        { type: "workload.completed", duplicate_inputs: 3 },
        { type: "workload.completed", duplicate_inputs: 3 },
        { type: "core.restart.completed", latency_ms: 1200 },
        { type: "mcp.reconnect.verified", latency_ms: 200 },
        { type: "window.ended", monotonic_elapsed_ms: 24 * HOUR }
      ],
      workloadReports: [workload(), workload()]
    });

    expect(analysis).toMatchObject({
      duration: { monotonic_ms: 24 * HOUR, wall_clock_ms: 24 * HOUR },
      sampling: { actual: 73, coverage: 1, expected: 73 },
      work: {
        agent_self_heal_success: 2,
        direct_success: 2,
        duplicate_execution: 0,
        duplicate_inputs: 6,
        final_failure: 0,
        first_failure: 2,
        correct_human_help: 2
      },
      reliability: {
        health_failure_samples: [],
        mcp_reconnect_latency_ms: 200,
        orphan_lease_max: 0,
        restart_latency_ms: 1200
      }
    });
  });

  test("does not disguise a short or sparse window as 24h evidence", () => {
    const analysis = analyzeEndurance({
      samples: [sample(0), sample(1)],
      state: state(),
      timeline: [{ type: "window.ended", monotonic_elapsed_ms: HOUR }],
      workloadReports: [workload()]
    });

    expect(analysis.duration).toMatchObject({
      monotonic_ms: HOUR,
      wall_clock_ms: 20 * 60 * 1000
    });
    expect(analysis.sampling.coverage).toBeLessThan(0.95);
    expect(analysis.work.first_failure).toBe(1);
    expect(analysis.work.final_failure).toBe(0);
  });
});

function state(): any {
  return {
    contract: "xw.agentic-activation.issue-785-controller-state.v1",
    duration_ms: 24 * HOUR,
    end_not_before: new Date(START + 24 * HOUR).toISOString(),
    expected_samples: 73,
    interval_ms: 20 * 60 * 1000,
    monotonic_started_ms: 1,
    pid: 1,
    started_at: new Date(START).toISOString(),
    started_epoch_ms: START
  };
}

function sample(slot: number): any {
  const sampledAt = new Date(START + slot * 20 * 60 * 1000).toISOString();
  return {
    contract: "xw.agentic-activation.issue-785-sample.v1",
    slot,
    scheduled_at: sampledAt,
    sampled_at: sampledAt,
    lateness_ms: 0,
    health: { web_ok: true, core_ok: true },
    db: { bytes: 1000 + slot, quick_check: "ok" },
    automation: { duplicate_idempotency_keys: 0 },
    heartbeat: { freshness_ms: 1000 },
    mcp: { enabled: 1, readiness: "ready" },
    runs: {},
    leases: { orphan_count: 0 },
    attention: {},
    resources: {
      app_support_bytes: 1000 + slot,
      artifact_bytes: 100 + slot,
      group_rss_bytes: 200 * 1024 * 1024 + (slot % 3) * 1024,
    }
  };
}

function workload(): any {
  const metric = (count: number) => ({ count, ids: [] });
  return {
    observer: {
      entity_index: { run_ids: ["run-direct", "run-failed", "run-retry"] },
      metrics: {
        agent_self_heal_success: metric(1),
        direct_success: metric(1),
        duplicate_execution: metric(0),
        false_or_stale_help: metric(0),
        final_failure: metric(0),
        human_help: metric(1),
        manual_status_modification: metric(0),
        total_work: metric(3)
      }
    },
    result: "passed"
  };
}
