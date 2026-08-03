import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectMacOSFootprint,
  PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS,
  PROCESS_GROUP_MEMORY_BUDGETS,
  PROCESS_GROUP_MEMORY_CONTRACT,
  PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS,
  ProcessGroupMemoryObserver,
  resolveRecoveredProcessGroupMemoryAlerts,
  type ProcessMemoryBudgetAlert,
  writeProcessGroupMemoryAlert
} from "./processGroupMemory.ts";
import type { ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import { openDatabase } from "../db/database.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";
import { ackPiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";

const MIB = 1024 * 1024;

describe("runner process-group memory observer", () => {
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

  test("includes the split Agentic Worker in the authoritative physical process group", async () => {
    const rows = [
      row(50, 1, 200, "Mon Jul 20 00:00:00 2026\tcodex-issue-runner-core"),
      row(60, 50, 170, "Mon Jul 20 00:01:00 2026\tcodex-issue-runner-agentic")
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

  test("publishes explicit soft and hard thresholds instead of the former one-gigabyte ceiling", () => {
    expect(PROCESS_GROUP_MEMORY_BUDGETS).toMatchObject({
      alert_after_ms: { hard: 180_000, soft: 180_000 },
      consecutive: { hard: 180, soft: 180 },
      idle_main_rss_bytes: { hard: 384 * MIB, soft: 320 * MIB },
      idle_group_rss_p95_bytes: { hard: 448 * MIB, soft: 384 * MIB },
      active_run_group_rss_p95_bytes: { hard: 896 * MIB, soft: 768 * MIB },
      post_run_delta_bytes: { hard: 96 * MIB },
      soak_drift_bytes: { hard: 128 * MIB }
    });
    expect(JSON.stringify(PROCESS_GROUP_MEMORY_BUDGETS)).not.toContain(String(1024 * MIB));
  });

  test("deduplicates a redacted budget alert into the existing Guardian Attention surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-alert-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const alert: ProcessMemoryBudgetAlert = {
      budget: { hard_bytes: 320 * MIB, status: "hard_exceeded" },
      level: "hard",
      phase: "idle",
      sample: { top_by_rss: [{ owner: "runner", pid: 50, role: "runner", rss_bytes: 330 * MIB }] }
    };
    try {
      writeProcessGroupMemoryAlert(database, alert);
      writeProcessGroupMemoryAlert(database, alert);
      const stored = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        run_group_id: "runner-memory",
        severity: "urgent",
        status: "open",
        ui_visible: 1
      });
      expect(stored[0]?.evidence_json).toContain('"pid":50');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("consolidates soft and hard transitions into one incident and reopens only on escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-levels-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      let incident = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      expect(incident).toMatchObject({ run_group_id: "runner-memory", severity: "high", status: "open" });
      ackPiGuardianAlert(database, incident.id);

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      incident = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      expect(incident).toMatchObject({ severity: "high", status: "acked" });

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "hard_exceeded" }, level: "hard", phase: "idle", sample: {}
      });
      const active = [
        ...listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "open" }),
        ...listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "acked" })
      ];
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ run_group_id: "runner-memory", severity: "urgent", status: "open" });
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("consolidates legacy per-level incidents without losing an acknowledgement of the peak", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-legacy-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy soft",
        run_group_id: "runner-memory:idle:soft", severity: "high", status: "open"
      });
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy hard",
        run_group_id: "runner-memory:idle:hard", severity: "urgent", status: "acked"
      });

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });

      const active = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "acked" });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ run_group_id: "runner-memory", severity: "urgent" });
      expect(listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "resolved" }))
        .toHaveLength(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves open and acknowledged memory incidents after a healthy sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-recovery-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "open memory alert",
        run_group_id: "runner-memory", severity: "urgent", status: "open"
      });
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy acked alert",
        run_group_id: "runner-memory:run:hard", severity: "urgent", status: "acked"
      });

      const resolved = resolveRecoveredProcessGroupMemoryAlerts(database, {
        budget: { status: "within_budget" }, phase: "idle", sampled_at: "2026-07-21T03:46:49Z"
      });

      expect(resolved).toBe(2);
      expect(listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "resolved" }))
        .toHaveLength(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reopens the canonical memory incident instead of creating alert history on every recovery flap", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-reopen-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      const original = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      resolveRecoveredProcessGroupMemoryAlerts(database, {
        budget: { status: "within_budget" }, phase: "idle", sampled_at: "2026-07-21T03:46:49Z"
      });
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "hard_exceeded" }, level: "hard", phase: "idle", sample: {}
      });

      const stored = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: original.id,
        run_group_id: "runner-memory",
        severity: "urgent",
        status: "open"
      });
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixtureRows(mainMiB: number, childMiB: number): ProcessTreeEntry[] {
  return [
    row(50, 1, mainMiB, "Mon Jul 20 00:00:00 2026\t/Users/private/runner --token runtime-secret"),
    row(100, 50, childMiB, "Mon Jul 20 01:00:00 2026\t/opt/codex app-server --token runtime-secret")
  ];
}

function row(pid: number, ppid: number, mib: number, command: string): ProcessTreeEntry {
  return { command, pgid: pid, pid, ppid, rss_bytes: mib * MIB };
}

function memoryUsage(rssMiB: number): ReturnType<typeof process.memoryUsage> {
  return { arrayBuffers: 3, external: 4, heapTotal: 5, heapUsed: 6, rss: rssMiB * MIB };
}

function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

type Snapshot = {
  activity: Record<string, unknown>;
  aggregate: Record<string, unknown>;
  budget: Record<string, unknown>;
  main: Record<string, unknown>;
  measurement: Record<string, unknown>;
  recently_exited: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  top_by_rss: Array<Record<string, unknown>>;
  phase: string;
};
