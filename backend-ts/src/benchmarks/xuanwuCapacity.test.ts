import { afterEach, describe, expect, test } from "bun:test";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPACITY_REPORT_SCHEMA,
  capacityLatencyRegressions,
  capacityReportMarkdown,
  generateCapacityDataset,
  runCapacityBenchmark,
  snapshotDatabase
} from "./xuanwuCapacity.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Xuanwu capacity benchmark", () => {
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
    const report = await runCapacityBenchmark({ dbPath, label: "focused-fixture", samples: 5, warmups: 1 });

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
