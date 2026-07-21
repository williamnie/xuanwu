import { afterEach, describe, expect, test } from "bun:test";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPACITY_BUDGETS,
  CAPACITY_REPORT_SCHEMA,
  capacityLatencyRegressions,
  capacityReportMarkdown,
  evaluateRunnerMemoryCapacity,
  generateCapacityDataset,
  runCapacityBenchmark,
  snapshotDatabase
} from "./xuanwuCapacity.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Xuanwu capacity benchmark", () => {
  test("rejects the previous one-gigabyte memory ceiling", () => {
    expect(CAPACITY_BUDGETS.memory).toMatchObject({
      peak_rss_bytes: 512 * 1024 * 1024,
      rss_growth_bytes: 384 * 1024 * 1024,
      process_group: {
        idle_group_rss_p95_bytes: { hard: 320 * 1024 * 1024 },
        active_run_group_rss_p95_bytes: { hard: 700 * 1024 * 1024 },
        post_run_delta_bytes: { hard: 32 * 1024 * 1024 },
        soak_drift_bytes: { hard: 64 * 1024 * 1024 }
      }
    });
    expect(JSON.stringify(CAPACITY_BUDGETS.memory)).not.toContain(String(1024 * 1024 * 1024));
  });

  test("gates every runner lifecycle phase, 20 cycles, 30-minute soak, baseline Evidence and review", () => {
    const mib = 1024 * 1024;
    const base = Date.parse("2026-07-20T00:00:00.000Z");
    const sample = (phase: Parameters<typeof evaluateRunnerMemoryCapacity>[0]["samples"][number]["phase"], offset: number, group = 250, cycle?: number) => ({
      ...(cycle === undefined ? {} : { cycle }),
      footprint_bytes: 190 * mib,
      freshness_status: "fresh",
      group_rss_bytes: group * mib,
      main_array_buffers_bytes: 5 * mib,
      main_external_bytes: 10 * mib,
      main_heap_used_bytes: 20 * mib,
      main_process_rss_bytes: 180 * mib,
      main_ps_rss_bytes: 181 * mib,
      observed_at: new Date(base + offset).toISOString(),
      phase,
      sample_age_ms: 100
    });
    const samples = [
      sample("cold_start", 0), sample("idle", 1_000), sample("usage_first", 2_000, 310),
      sample("usage_warm", 3_000, 280), sample("run", 4_000, 620), sample("cancel", 5_000, 300),
      sample("failure_retry", 6_000, 650), sample("restart", 7_000, 290), sample("post_ttl", 8_000, 270),
      ...Array.from({ length: 20 }, (_, index) => sample("lifecycle", 10_000 + index * 1_000, 260 + (index % 2), index + 1)),
      sample("soak", 30_000, 260), sample("soak", 30_000 + 30 * 60_000, 300)
    ];
    const report = evaluateRunnerMemoryCapacity({
      baselineEvidenceId: "xw:evidence:issue_events:765-baseline",
      reviewedBy: "capacity-review:mem-04",
      samples
    });

    expect(report).toMatchObject({
      lifecycle: { cycles: 20, monotonic_growth: false, status: "passed" },
      group_p95_rss_bytes: { active_run: 650 * mib, inactive: 300 * mib, main_idle: 181 * mib },
      metric_definitions: {
        footprint_bytes: expect.stringContaining("macOS footprint"),
        process_rss_bytes: expect.stringContaining("main process only"),
        ps_rss_bytes: expect.stringContaining("macOS ps")
      },
      missing_phases: [],
      phase_p95_footprint_bytes: { idle: 190 * mib, run: 190 * mib, soak: 190 * mib },
      phase_p95_main_memory_bytes: {
        array_buffers: { idle: 5 * mib, run: 5 * mib },
        external: { idle: 10 * mib, run: 10 * mib },
        heap_used: { idle: 20 * mib, run: 20 * mib }
      },
      soak: { drift_bytes: 40 * mib, duration_ms: 30 * 60_000, status: "passed" },
      sampling: { fresh: true, samples: samples.length, status: "passed" },
      status: "passed"
    });
    expect(evaluateRunnerMemoryCapacity({ baselineEvidenceId: "", reviewedBy: "", samples })).toMatchObject({ status: "failed" });
    expect(evaluateRunnerMemoryCapacity({
      baselineEvidenceId: "xw:evidence:issue_events:765-baseline",
      reviewedBy: "capacity-review:mem-04",
      samples: samples.map((item, index) => index === 0 ? { ...item, freshness_status: "stale", sample_age_ms: 6_000 } : item)
    })).toMatchObject({ sampling: { status: "failed" }, status: "failed" });
  });

  test("generates all capacity dimensions and emits executable P50/P95 budgets", async () => {
    const root = await fixtureRoot();
    const dbPath = join(root, "capacity.db");
    const generated = await generateCapacityDataset(dbPath, {
      automations_per_project: 2,
      automation_events_per_automation: 3,
      automation_runs_per_automation: 2,
      events_per_issue: 5,
      issues_per_project: 3,
      projects: 2,
      runs_per_issue: 2,
      sessions_per_issue: 1
    });

    expect(generated.scale).toMatchObject({ projects: 2, issues_per_project: 3, events_per_issue: 5 });
    const report = await runCapacityBenchmark({
      dbPath,
      label: "focused-fixture",
      readRSSBytes: () => 128 * 1024 * 1024,
      samples: 5,
      warmups: 1
    });

    expect(report).toMatchObject({
      schema_version: CAPACITY_REPORT_SCHEMA,
      status: "passed",
      database: { issue_event_rows: 30, event_summary_projection_rows: 30, projection_lag_rows: 0 },
      scale: {
        active_runs: 3,
        agent_sessions: 6,
        automation_definitions: 4,
        automation_events: 12,
        automation_runs: 8,
        issue_runs: 12,
        issues: 6,
        projects: 2,
        run_attempts: 12
      }
    });
    expect(Object.keys(report.latency_ms)).toEqual([
      "projects.frontend_list",
      "issues.frontend_page_100",
      "sessions.project_catalog",
      "runs.frontend_page_100",
      "runs.active_projection_8",
      "automations.frontend_list_500",
      "timeline.long_session_first_60"
    ]);
    expect(Object.values(report.latency_ms).every((item) => item.samples === 5 && item.p95 >= item.p50)).toBe(true);
    expect(report.query_plans.timeline_summary_page.join("\n")).toContain("idx_event_summary_projection_issue");
    expect(report.authority.events).toContain("issue_events");
    expect(report.authority.compatibility).toContain("no dual-read");
    expect(capacityReportMarkdown(report)).toContain("Raw + projection");

    const candidate = structuredClone(report.latency_ms);
    const baseline = structuredClone(report);
    baseline.latency_ms["runs.frontend_page_100"]!.p95 = 10;
    candidate["runs.frontend_page_100"]!.p95 = 20;
    expect(capacityLatencyRegressions(baseline, candidate)).toEqual([{
      baseline_p95: 10,
      candidate_p95: 20,
      name: "runs.frontend_page_100",
      ratio: 2
    }]);
  });

  test("takes a consistent non-overwriting database snapshot", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "source.db");
    const outputPath = join(root, "snapshot.db");
    await generateCapacityDataset(sourcePath, {
      automations_per_project: 0,
      automation_events_per_automation: 0,
      automation_runs_per_automation: 0,
      events_per_issue: 2,
      issues_per_project: 2,
      projects: 1,
      runs_per_issue: 1,
      sessions_per_issue: 0
    });

    const result = await snapshotDatabase(sourcePath, outputPath);
    const snapshot = new SQLiteDatabase(outputPath, { readonly: true });
    expect(result.bytes).toBeGreaterThan(0);
    expect(snapshot.query<{ count: number }, []>("select count(*) as count from issue_events").get()?.count).toBe(4);
    snapshot.close();
    await expect(snapshotDatabase(sourcePath, outputPath)).rejects.toThrow("refusing to overwrite");
    await expect(generateCapacityDataset(join(root, "too-large.db"), {
      events_per_issue: 1_000_000,
      issues_per_project: 1_000_000,
      projects: 10_000
    })).rejects.toThrow("dataset would create");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-capacity-"));
  roots.push(root);
  return root;
}
