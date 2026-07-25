import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";
import {
  reportFromSampleLog,
  runIssue784Fixture,
  sampleObservationWindow
} from "./intake-observability-live.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Issue 784 intake observability live fixture", () => {
  test("runs three E2E cycles, aggregates by Work, and rebuilds deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-784-test-"));
    roots.push(root);
    const report = await runIssue784Fixture(root);
    const rebuilt = reportFromSampleLog(join(root, "raw-samples.jsonl"));

    expect(report.result).toBe("passed");
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(rebuilt.sample_cycles).toBe(3);
    expect(rebuilt.metrics.total_work.count).toBe(3);
    expect(rebuilt.metrics.direct_success.count).toBe(1);
    expect(rebuilt.metrics.agent_self_heal_success.count).toBe(1);
    expect(rebuilt.metrics.final_failure.count).toBe(0);
    expect(rebuilt.metrics.human_help.count).toBe(1);
    expect(rebuilt.metrics.false_or_stale_help.count).toBe(0);
    expect(rebuilt.metrics.duplicate_execution.count).toBe(0);
    expect(rebuilt.metrics.manual_status_modification.count).toBe(0);
    expect(rebuilt.metrics.detection_latency.count).toBe(3);
    expect(rebuilt.metrics.recovery_latency.count).toBe(1);
  }, 30_000);

  test("persists a read-only sampling watermark across unattended cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-784-sampler-"));
    roots.push(root);
    const writer = await openDatabase({ stateDir: join(root, "state") });
    const dbPath = writer.path;
    writer.close();
    const outputPath = join(root, "observation", "raw-samples.jsonl");
    const statePath = join(root, "observation", "sampler-state.json");

    const first = await sampleObservationWindow({
      dbPath,
      outputPath,
      projectID: "codex-issue-runner",
      statePath,
      windowStartedAt: "2026-07-25T00:00:00Z"
    });
    const second = await sampleObservationWindow({
      dbPath,
      outputPath,
      projectID: "codex-issue-runner",
      statePath
    });
    const report = reportFromSampleLog(outputPath);

    expect(first.cycle).toBe(1);
    expect(second.cycle).toBe(2);
    expect(second.window.started_at).toBe("2026-07-25T00:00:00.000Z");
    expect(report.sample_cycles).toBe(2);
    expect(report.watermark_start).toEqual(first.watermark_end);
    expect(report.watermark_end).toEqual(second.watermark_end);
    expect(report.metrics.total_work.count).toBe(0);
  });
});
