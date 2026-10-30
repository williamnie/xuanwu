import { expect, test } from "bun:test";

import {
  PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS,
  PROCESS_GROUP_MEMORY_BUDGETS,
  PROCESS_GROUP_MEMORY_CONTRACT,
  PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS,
  ProcessGroupMemoryObserver,
  type ProcessMemoryBudgetAlert
} from "./processGroupMemory.ts";

import { MIB, fixtureRows, row, memoryUsage, tickingClock, Snapshot } from "./processGroupMemoryTestFixtures.ts";

export function registerProcessGroupMemoryAttributionCases() {
  test("reclaims after a short Core maintenance cooldown even when no issue or Agentic RPC is active", async () => {
    let nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    let footprintMiB = 180;
    let reclaims = 0;
    let rssMiB = 180;
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      agenticActivity: () => ({ in_flight: 0, last_activity_at: "" }),
      footprint: async () => new Map([[50, footprintMiB * MIB]]),
      footprintIntervalMs: 60_000,
      inspect: () => [fixtureRows(rssMiB, 0)[0]!],
      memoryUsage: () => memoryUsage(rssMiB),
      now: () => new Date(nowMs),
      providerRuntime: () => ({ idle_ttl_ms: 10_000, owners: [] }),
      reclaimMemory: () => {
        reclaims += 1;
        footprintMiB = 180;
      },
      runnerPid: 50
    });

    observer.sample();
    await Bun.sleep(0);
    footprintMiB = 300;
    rssMiB = 300;
    await observer.runMaintenance(async () => {
      expect(observer.sample()).toMatchObject({
        phase: "run",
        activity: { maintenance_in_flight: 1, status: "active" }
      });
    });

    let snapshot = observer.sample() as Snapshot;
    expect(snapshot).toMatchObject({
      phase: "run",
      activity: { maintenance_in_flight: 0, status: "cooldown" }
    });
    expect(reclaims).toBe(0);

    nowMs += PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS + 1;
    snapshot = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(snapshot).toMatchObject({
      phase: "idle",
      activity: { maintenance_in_flight: 0, status: "idle" },
      budget: { measurement_ready: false, status: "measurement_pending" }
    });

    await Bun.sleep(0);
    observer.sample();
    await Bun.sleep(0);
    snapshot = observer.sample() as Snapshot;
    expect(reclaims).toBe(1);
    expect(snapshot).toMatchObject({
      aggregate: { footprint_bytes: 180 * MIB },
      budget: { measured_main_bytes: 180 * MIB, status: "within_budget" },
      phase: "idle"
    });

    nowMs += 10_001;
    snapshot = observer.sample() as Snapshot;
    expect(snapshot).toMatchObject({
      budget: { post_run: { status: "not_pending" }, status: "within_budget" },
      phase: "idle"
    });
  });

  test("discards an in-flight pre-reclaim footprint before accepting the idle measurement", async () => {
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    let activity = { in_flight: 1, last_activity_at: new Date(nowMs).toISOString() };
    const measurements: Array<(value: Map<number, number>) => void> = [];
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      agenticActivity: () => activity,
      footprint: () => new Promise((resolve) => { measurements.push(resolve); }),
      inspect: () => [fixtureRows(300, 0)[0]!],
      memoryUsage: () => memoryUsage(300),
      now: () => new Date(nowMs),
      reclaimMemory: () => {},
      runnerPid: 50
    });

    observer.sample();
    expect(measurements).toHaveLength(1);
    activity = { in_flight: 0, last_activity_at: new Date(nowMs).toISOString() };
    nowMs += PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS + 1;
    expect((observer.sample() as Snapshot).budget.status).toBe("measurement_pending");

    measurements[0]!(new Map([[50, 300 * MIB]]));
    await Bun.sleep(0);
    expect((observer.sample() as Snapshot).budget.status).toBe("measurement_pending");
    expect(measurements).toHaveLength(2);

    measurements[1]!(new Map([[50, 180 * MIB]]));
    await Bun.sleep(0);
    const settled = observer.sample() as Snapshot;
    expect(settled).toMatchObject({
      aggregate: { footprint_bytes: 180 * MIB },
      budget: { measured_main_bytes: 180 * MIB, status: "within_budget" },
      phase: "idle"
    });
  });

  test("defers the post-run reclaim through usage work and performs it on true idle", () => {
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    let activity = { in_flight: 1, last_activity_at: new Date(nowMs).toISOString() };
    let rows = [fixtureRows(200, 0)[0]!];
    let reclaims = 0;
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      agenticActivity: () => activity,
      footprint: false,
      inspect: () => rows,
      memoryUsage: () => memoryUsage(200),
      now: () => new Date(nowMs),
      reclaimMemory: () => { reclaims += 1; },
      runnerPid: 50
    });

    expect((observer.sample() as Snapshot).phase).toBe("run");
    activity = { in_flight: 0, last_activity_at: new Date(nowMs).toISOString() };
    nowMs += PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS + 1;
    rows = [
      fixtureRows(200, 0)[0]!,
      row(70, 50, 20, "Mon Jul 20 00:02:00 2026\t__usage-index-worker")
    ];
    expect((observer.sample() as Snapshot).phase).toBe("usage");
    expect(reclaims).toBe(0);

    rows = [fixtureRows(180, 0)[0]!];
    expect((observer.sample() as Snapshot).phase).toBe("idle");
    expect(reclaims).toBe(1);
    observer.sample();
    expect(reclaims).toBe(1);
  });

  test("aggregates the runner tree by safe role and owner without exposing commands, tokens, or paths", async () => {
    const alerts: ProcessMemoryBudgetAlert[] = [];
    const rows = fixtureRows(200, 260);
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      footprint: false,
      footprintIntervalMs: 0,
      inspect: () => rows,
      memoryUsage: () => memoryUsage(198),
      now: tickingClock(),
      onAlert: (alert) => alerts.push(alert),
      providerRuntime: () => ({
        owners: ["project:/Users/private:issue:765:run --token=runtime-secret"],
        process: { root_pid: 100 } as never
      }),
      runnerPid: 50
    });

    let snapshot = observer.sample() as Snapshot;
    for (let sample = 1; sample < PROCESS_GROUP_MEMORY_BUDGETS.consecutive.hard; sample += 1) {
      snapshot = observer.sample() as Snapshot;
    }
    await Bun.sleep(0);

    expect(snapshot).toMatchObject({
      contract: PROCESS_GROUP_MEMORY_CONTRACT,
      phase: "idle",
      aggregate: { process_count: 2, rss_bytes: 460 * MIB, rss_p95_bytes: 460 * MIB },
      main: { pid: 50, role: "runner", ps_rss_bytes: 200 * MIB, process_rss_bytes: 198 * MIB },
      budget: {
        alert_after_ms: { hard: 180_000, soft: 180_000 },
        auto_restart: false,
        hard_bytes: 448 * MIB,
        required_consecutive_hard: 180,
        status: "hard_exceeded"
      }
    });
    expect(snapshot.roles.map((item) => item.role)).toEqual(["codex-app-server", "runner"]);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("runtime-secret");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/private");
    expect(JSON.stringify(alerts)).not.toContain("runtime-secret");
  });
}
