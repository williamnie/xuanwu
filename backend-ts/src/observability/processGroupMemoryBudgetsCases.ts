import { expect, test } from "bun:test";

import {
  collectMacOSFootprint,
  PROCESS_GROUP_MEMORY_BUDGETS,
  ProcessGroupMemoryObserver
} from "./processGroupMemory.ts";

import { MIB, fixtureRows, row, memoryUsage, tickingClock, Snapshot } from "./processGroupMemoryTestFixtures.ts";

export function registerProcessGroupMemoryBudgetsCases() {
  test("includes the split Agentic Worker in the authoritative physical process group", async () => {
    const rows = [
      row(50, 1, 200, "Mon Jul 20 00:00:00 2026\txuanwu-core"),
      row(60, 50, 170, "Mon Jul 20 00:01:00 2026\txuanwu-agentic")
    ];
    const observer = new ProcessGroupMemoryObserver({
      agenticActivity: () => ({ in_flight: 1, last_activity_at: "2026-07-27T03:00:00.000Z" }),
      footprint: async () => new Map([[50, 190 * MIB], [60, 150 * MIB]]),
      inspect: () => rows,
      memoryUsage: () => memoryUsage(200),
      now: () => new Date("2026-07-27T03:00:00.000Z"),
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    const snapshot = observer.sample() as Snapshot;
    expect(snapshot).toMatchObject({
      aggregate: { footprint_bytes: 340 * MIB, footprint_process_count: 2, process_count: 2 },
      budget: { measured_group_bytes: 340 * MIB, measurement_source: "footprint", status: "within_budget" },
      phase: "run"
    });
    expect(snapshot.roles).toContainEqual(expect.objectContaining({ process_count: 1, role: "agentic-worker" }));
    expect(snapshot.top_by_rss).toContainEqual(expect.objectContaining({ owner: "runner:agentic", pid: 60 }));
  });

  test("tracks PID reuse and retains observed short-lived descendants", () => {
    let rows = fixtureRows(180, 20);
    const observer = new ProcessGroupMemoryObserver({
      footprint: async () => new Map(),
      inspect: () => rows,
      memoryUsage: () => memoryUsage(180),
      now: tickingClock(),
      runnerPid: 50
    });
    observer.sample();
    rows = [rows[0]!, {
      ...rows[1]!,
      command: "Tue Jul 21 01:00:00 2026\t/opt/codex app-server"
    }];
    const snapshot = observer.sample() as Snapshot;

    expect(snapshot.recently_exited).toEqual([expect.objectContaining({
      pid: 100,
      peak_rss_bytes: 20 * MIB,
      started_at: "Mon Jul 20 01:00:00 2026"
    })]);
    expect(snapshot.top_by_rss).toContainEqual(expect.objectContaining({
      pid: 100,
      started_at: "Tue Jul 21 01:00:00 2026"
    }));
  });

  test("uses a fresh complete macOS footprint for budgets while retaining RSS diagnostics", async () => {
    const rows = fixtureRows(200, 130);
    const observer = new ProcessGroupMemoryObserver({
      footprint: async (pids) => new Map(pids.map((pid) => [pid, pid === 50 ? 190 * MIB : 80 * MIB])),
      footprintIntervalMs: 60_000,
      inspect: () => rows,
      memoryUsage: () => memoryUsage(198),
      now: tickingClock(),
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    const snapshot = observer.sample() as Snapshot;

    expect(snapshot).toMatchObject({
      aggregate: { footprint_bytes: 270 * MIB, rss_p95_bytes: 330 * MIB },
      measurement: { physical_memory_probe: "ready", source: "footprint" },
      budget: {
        measured_group_bytes: 270 * MIB,
        measured_main_bytes: 190 * MIB,
        measurement_source: "footprint",
        status: "within_budget"
      }
    });
  });

  test("keeps the budget pending until the first physical measurement completes", async () => {
    let complete!: (value: Map<number, number>) => void;
    const observer = new ProcessGroupMemoryObserver({
      footprint: () => new Promise((resolve) => { complete = resolve; }),
      inspect: () => fixtureRows(300, 50),
      memoryUsage: () => memoryUsage(300),
      now: tickingClock(),
      runnerPid: 50
    });

    expect((observer.sample() as Snapshot).budget).toMatchObject({
      measurement_ready: false,
      status: "measurement_pending"
    });
    complete(new Map([[50, 180 * MIB], [100, 70 * MIB]]));
    await Bun.sleep(0);
    expect((observer.sample() as Snapshot).budget).toMatchObject({
      measured_group_bytes: 250 * MIB,
      measurement_ready: true,
      measurement_source: "footprint",
      status: "within_budget"
    });
  });

  test("collects macOS physical footprint without invoking the suspending footprint executable", async () => {
    const values = await collectMacOSFootprint([process.pid]);
    if (process.platform !== "darwin") {
      expect(values.size).toBe(0);
      return;
    }
    expect(values.get(process.pid)).toBeGreaterThan(0);
  });

  test("uses RSS only for descendants that appeared after the last footprint instead of discarding physical memory", async () => {
    let rows = fixtureRows(200, 130);
    const observer = new ProcessGroupMemoryObserver({
      footprint: async (pids) => new Map(pids.map((pid) => [
        pid,
        pid === 50 ? 190 * MIB : pid === 100 ? 80 * MIB : 10 * MIB
      ])),
      footprintIntervalMs: 60_000,
      inspect: () => rows,
      memoryUsage: () => memoryUsage(198),
      now: tickingClock(),
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    rows = [...rows, row(101, 100, 10, "Mon Jul 20 01:01:00 2026\t/tool-host")];
    const snapshot = observer.sample() as Snapshot;

    expect(snapshot.budget).toMatchObject({
      measured_group_bytes: 280 * MIB,
      measured_main_bytes: 190 * MIB,
      measurement_source: "footprint+rss",
      status: "within_budget"
    });
    await Bun.sleep(0);
    expect((observer.sample() as Snapshot).budget).toMatchObject({
      measured_group_bytes: 280 * MIB,
      measurement_source: "footprint",
      status: "within_budget"
    });
  });

  test("requires the process group to return to its measured idle baseline after provider TTL", () => {
    let activeRuns = 0;
    let groupMiB = 250;
    let nowMs = Date.parse("2026-07-20T00:00:00.000Z");
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => activeRuns,
      footprint: false,
      inspect: () => fixtureRows(180, groupMiB - 180),
      memoryUsage: () => memoryUsage(180),
      now: () => new Date(nowMs),
      providerRuntime: () => ({ idle_ttl_ms: 15_000, owners: [] }),
      runnerPid: 50
    });
    observer.sample();
    activeRuns = 1;
    groupMiB = 600;
    nowMs += 1_000;
    observer.sample();
    activeRuns = 0;
    groupMiB = 350;
    nowMs += 16_000;
    let snapshot = observer.sample() as Snapshot;
    for (let sample = 1; sample < PROCESS_GROUP_MEMORY_BUDGETS.consecutive.hard; sample += 1) {
      nowMs += 1_000;
      snapshot = observer.sample() as Snapshot;
    }

    expect(snapshot.budget).toMatchObject({
      post_run: { baseline_rss_bytes: 250 * MIB, delta_bytes: 100 * MIB, status: "hard_exceeded", ttl_ms: 15_000 },
      status: "hard_exceeded"
    });
  });
}
