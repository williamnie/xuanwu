import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_GROUP_MEMORY_BUDGETS,
  PROCESS_GROUP_MEMORY_CONTRACT,
  ProcessGroupMemoryObserver,
  resolveRecoveredProcessGroupMemoryAlerts,
  type ProcessMemoryBudgetAlert,
  writeProcessGroupMemoryAlert
} from "./processGroupMemory.ts";
import type { ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import { openDatabase } from "../db/database.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";

const MIB = 1024 * 1024;

describe("runner process-group memory observer", () => {
  test("aggregates the runner tree by safe role and owner without exposing commands, tokens, or paths", async () => {
    const alerts: ProcessMemoryBudgetAlert[] = [];
    const rows = fixtureRows(200, 130);
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => 0,
      footprint: async (pids) => new Map(pids.map((pid) => [pid, pid === 50 ? 190 * MIB : 100 * MIB])),
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

    observer.sample();
    observer.sample();
    const snapshot = observer.sample() as Snapshot;
    await Bun.sleep(0);

    expect(snapshot).toMatchObject({
      contract: PROCESS_GROUP_MEMORY_CONTRACT,
      phase: "idle",
      aggregate: { process_count: 2, rss_bytes: 330 * MIB, rss_p95_bytes: 330 * MIB },
      main: { pid: 50, role: "runner", ps_rss_bytes: 200 * MIB, process_rss_bytes: 198 * MIB },
      budget: { auto_restart: false, hard_bytes: 320 * MIB, status: "hard_exceeded" }
    });
    expect(snapshot.roles.map((item) => item.role)).toEqual(["runner", "codex-app-server"]);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("runtime-secret");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/private");
    expect(JSON.stringify(alerts)).not.toContain("runtime-secret");
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
      budget: {
        measured_group_bytes: 270 * MIB,
        measured_main_bytes: 190 * MIB,
        measurement_source: "footprint",
        status: "within_budget"
      }
    });
  });

  test("uses RSS only for descendants that appeared after the last footprint instead of discarding physical memory", async () => {
    let rows = fixtureRows(200, 130);
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
    rows = [...rows, row(101, 100, 10, "Mon Jul 20 01:01:00 2026\t/tool-host")];
    const snapshot = observer.sample() as Snapshot;

    expect(snapshot.budget).toMatchObject({
      measured_group_bytes: 280 * MIB,
      measured_main_bytes: 190 * MIB,
      measurement_source: "footprint+rss",
      status: "within_budget"
    });
  });

  test("requires the process group to return to its measured idle baseline after provider TTL", () => {
    let activeRuns = 0;
    let groupMiB = 250;
    let nowMs = Date.parse("2026-07-20T00:00:00.000Z");
    const observer = new ProcessGroupMemoryObserver({
      activeRuns: () => activeRuns,
      footprint: async () => new Map(),
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
    groupMiB = 290;
    nowMs += 16_000;
    observer.sample();
    observer.sample();
    const snapshot = observer.sample() as Snapshot;

    expect(snapshot.budget).toMatchObject({
      post_run: { baseline_rss_bytes: 250 * MIB, delta_bytes: 40 * MIB, status: "hard_exceeded", ttl_ms: 15_000 },
      status: "hard_exceeded"
    });
  });

  test("publishes explicit soft and hard thresholds instead of the former one-gigabyte ceiling", () => {
    expect(PROCESS_GROUP_MEMORY_BUDGETS).toMatchObject({
      consecutive: { hard: 3, soft: 6 },
      idle_main_rss_bytes: { hard: 256 * MIB, soft: 224 * MIB },
      idle_group_rss_p95_bytes: { hard: 320 * MIB, soft: 288 * MIB },
      active_run_group_rss_p95_bytes: { hard: 700 * MIB, soft: 640 * MIB },
      post_run_delta_bytes: { hard: 32 * MIB },
      soak_drift_bytes: { hard: 64 * MIB }
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
        run_group_id: "runner-memory:idle:hard",
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

  test("resolves open and acknowledged memory incidents after a healthy sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-recovery-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const phase of ["idle", "run"] as const) {
        writeProcessGroupMemoryAlert(database, {
          budget: { status: "hard_exceeded" }, level: "hard", phase, sample: {}
        });
      }
      database.sqlite.run("update pi_guardian_alerts set status='acked' where run_group_id='runner-memory:run:hard'");

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
  aggregate: Record<string, unknown>;
  budget: Record<string, unknown>;
  main: Record<string, unknown>;
  recently_exited: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  top_by_rss: Array<Record<string, unknown>>;
};
