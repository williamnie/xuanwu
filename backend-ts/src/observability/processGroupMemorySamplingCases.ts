import { expect, test } from "bun:test";

import {
  PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS,
  PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS,
  ProcessGroupMemoryObserver
} from "./processGroupMemory.ts";

import { MIB, fixtureRows, memoryUsage, Snapshot } from "./processGroupMemoryTestFixtures.ts";

export function registerProcessGroupMemorySamplingCases() {
  test("returns an isolated JSON snapshot without sharing nested state", () => {
    const observer = new ProcessGroupMemoryObserver({
      footprint: false,
      inspect: () => [fixtureRows(180, 0)[0]!],
      memoryUsage: () => memoryUsage(180),
      now: () => new Date("2026-07-27T03:00:00.000Z"),
      runnerPid: 50
    });

    const first = observer.sample() as Snapshot;
    first.activity.status = "mutated";

    expect((observer.snapshot() as Snapshot).activity.status).toBe("idle");
  });

  test("treats Agentic RPC work and its idle grace as active workload instead of idle", async () => {
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    let activity = { in_flight: 1, last_activity_at: new Date(nowMs).toISOString() };
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      agenticActivity: () => activity,
      footprint: async () => new Map([[50, 300 * MIB]]),
      inspect: () => [fixtureRows(300, 0)[0]!],
      memoryUsage: () => memoryUsage(300),
      now: () => new Date(nowMs),
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    let snapshot = observer.sample() as Snapshot;
    expect(snapshot).toMatchObject({
      phase: "run",
      activity: { agentic_in_flight: 1, issue_runs: 0, status: "active" },
      budget: {
        hard_bytes: 896 * MIB,
        main_hard_bytes: null,
        measured_main_bytes: 300 * MIB,
        status: "within_budget"
      }
    });

    activity = { in_flight: 0, last_activity_at: new Date(nowMs).toISOString() };
    nowMs += PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS - 1;
    snapshot = observer.sample() as Snapshot;
    expect(snapshot).toMatchObject({
      phase: "run",
      activity: { agentic_in_flight: 0, status: "cooldown" },
      budget: { status: "within_budget" }
    });
  });

  test("reclaims once and requires a fresh physical measurement when active work becomes idle", async () => {
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    let activity = { in_flight: 1, last_activity_at: new Date(nowMs).toISOString() };
    let footprintMiB = 300;
    let reclaims = 0;
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      agenticActivity: () => activity,
      footprint: async () => new Map([[50, footprintMiB * MIB]]),
      footprintIntervalMs: 0,
      inspect: () => [fixtureRows(300, 0)[0]!],
      memoryUsage: () => memoryUsage(300),
      now: () => new Date(nowMs),
      reclaimMemory: () => {
        reclaims += 1;
        footprintMiB = 180;
      },
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    expect((observer.sample() as Snapshot).phase).toBe("run");

    activity = { in_flight: 0, last_activity_at: new Date(nowMs).toISOString() };
    nowMs += PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS + 1;
    const pending = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(pending).toMatchObject({
      phase: "idle",
      activity: { status: "idle" },
      budget: { measurement_ready: false, status: "measurement_pending" }
    });

    await Bun.sleep(0);
    expect((observer.sample() as Snapshot).budget).toMatchObject({ status: "measurement_pending" });
    await Bun.sleep(0);
    const settled = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(settled).toMatchObject({
      aggregate: { footprint_bytes: 180 * MIB },
      budget: { measured_main_bytes: 180 * MIB, status: "within_budget" },
      phase: "idle"
    });
  });

  test("throttles repeated forced reclaims across short active-to-idle cycles", () => {
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    let activeRuns = 1;
    let reclaims = 0;
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => activeRuns,
      footprint: false,
      inspect: () => [fixtureRows(180, 0)[0]!],
      memoryUsage: () => memoryUsage(180),
      now: () => new Date(nowMs),
      reclaimMemory: () => { reclaims += 1; },
      runnerPid: 50
    });

    observer.sample();
    activeRuns = 0;
    let snapshot = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(snapshot.memory_reclaim).toMatchObject({ status: "completed" });

    activeRuns = 1;
    observer.sample();
    activeRuns = 0;
    nowMs += PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS - 1;
    snapshot = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(snapshot.memory_reclaim).toMatchObject({ status: "throttled" });

    activeRuns = 1;
    observer.sample();
    activeRuns = 0;
    nowMs += 1;
    snapshot = observer.sample() as Snapshot;
    expect(reclaims).toBe(2);
    expect(snapshot.memory_reclaim).toMatchObject({ status: "completed" });
  });
}
