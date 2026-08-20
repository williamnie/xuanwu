import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODEX_PROCESS_OWNERSHIP_CONTRACT,
  CodexProcessGroupLifecycle,
  reconcileStaleCodexProcessOwnership,
  type ProcessSignal,
  type ProcessTreeEntry
} from "./processLifecycle.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Codex process group lifecycle", () => {
  test("records the app-server and detached MCP descendant groups, then TERM-cleans only matching ownership", async () => {
    const file = await ownershipFile();
    let rows = processRows();
    const signals: Array<[number, ProcessSignal]> = [];
    let exit!: (code: number) => void;
    const process = { pid: 100, exited: new Promise<number>((resolve) => { exit = resolve; }), kill: () => {} };
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => rows,
      runnerPid: 50,
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        if (signal === "SIGTERM" && pgid === 100) exit(0);
      },
      sleep: async () => { rows = []; },
      stopGraceMs: 1
    });

    await lifecycle.register(process);
    const ownership = JSON.parse(await readFile(file, "utf8"));
    expect(ownership).toMatchObject({
      contract: CODEX_PROCESS_OWNERSHIP_CONTRACT,
      root_pgid: 100,
      root_pid: 100,
      runner_pid: 50
    });
    expect(ownership.processes.map((item: ProcessTreeEntry) => [item.pid, item.pgid])).toEqual([
      [100, 100], [101, 101], [102, 101]
    ]);

    await lifecycle.stop(process);

    expect(signals).toEqual([[101, "SIGTERM"], [100, "SIGTERM"]]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reclaims a persisted stale ownership record but refuses PID-reused commands", async () => {
    const file = await ownershipFile();
    const rows = processRows();
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => rows,
      runnerPid: 50
    });
    await lifecycle.register({ pid: 100, exited: Promise.resolve(0), kill: () => {} });
    const signals: Array<[number, ProcessSignal]> = [];
    let current = rows;

    const result = await reconcileStaleCodexProcessOwnership(file, {
      inspect: () => current,
      runnerPid: 60,
      signalGroup: (pgid, signal) => signals.push([pgid, signal]),
      sleep: async () => { current = []; },
      stopGraceMs: 1
    });

    expect(result).toMatchObject({ action: "killed", killed_process_groups: [101, 100], stale_root_pid: 100 });
    expect(signals).toEqual([[101, "SIGTERM"], [100, "SIGTERM"]]);

    await lifecycle.register({ pid: 100, exited: Promise.resolve(0), kill: () => {} });
    const mismatch = await reconcileStaleCodexProcessOwnership(file, {
      inspect: () => rows.map((row) => row.pid === 100 ? { ...row, command: "unrelated-service" } : row),
      runnerPid: 60,
      signalGroup: (pgid, signal) => signals.push([pgid, signal]),
      sleep: async () => {},
      stopGraceMs: 1
    });
    expect(mismatch.action).toBe("ownership_mismatch");
    expect(signals).toHaveLength(2);
  });

  test("coalesces concurrent refreshes into one inspection and one persisted snapshot", async () => {
    const file = await ownershipFile();
    let rows = processRows();
    let inspections = 0;
    let clock = 0;
    const process = { pid: 100, exited: Promise.resolve(0), kill: () => {} };
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => {
        inspections += 1;
        return rows;
      },
      now: () => new Date(++clock * 1_000),
      minScanIntervalMs: 0,
      runnerPid: 50
    });
    await lifecycle.register(process);
    rows = [...rows, { command: "node mcp/new-worker.mjs", pgid: 103, pid: 103, ppid: 100, rss_bytes: 2_048 }];

    await Promise.all(Array.from({ length: 1_000 }, () => lifecycle.refresh(process)));

    expect(inspections).toBe(2);
    expect(clock).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      observed_at: new Date(2_000).toISOString(),
      processes: expect.arrayContaining([expect.objectContaining({ pid: 103, pgid: 103 })])
    });
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("coalesces an in-flight refresh request into one trailing scan", async () => {
    const file = await ownershipFile();
    const rows = processRows();
    const process = { pid: 100, exited: Promise.resolve(0), kill: () => {} };
    let inspections = 0;
    let requestTrailing = false;
    let trailing: Promise<void> | undefined;
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => {
        inspections += 1;
        if (requestTrailing) {
          requestTrailing = false;
          trailing = lifecycle.refresh(process);
        }
        return rows;
      },
      minScanIntervalMs: 0,
      runnerPid: 50
    });
    await lifecycle.register(process);
    requestTrailing = true;

    await lifecycle.refresh(process);
    await trailing;

    expect(inspections).toBe(3);
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("does not let a stale exit clear or signal a newer process ownership", async () => {
    const file = await ownershipFile();
    const rows = [
      ...processRows(),
      { command: "/opt/codex app-server --listen stdio://", pgid: 300, pid: 300, ppid: 50, rss_bytes: 16_384 }
    ];
    const signals: Array<[number, ProcessSignal]> = [];
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => rows,
      runnerPid: 50,
      signalGroup: (pgid, signal) => signals.push([pgid, signal]),
      sleep: async () => {},
      stopGraceMs: 1
    });
    let oldKills = 0;
    const oldProcess = { pid: 100, exited: Promise.resolve(0), kill: () => { oldKills += 1; } };
    const newProcess = { pid: 300, exited: Promise.resolve(0), kill: () => {} };
    await lifecycle.register(oldProcess);
    await lifecycle.register(newProcess);

    await lifecycle.stop(oldProcess);
    await lifecycle.processExited(oldProcess);

    expect(lifecycle.snapshot()).toMatchObject({ root_pid: 300 });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ root_pid: 300 });
    expect(oldKills).toBe(1);
    expect(signals).toEqual([]);
  });

  test("does not rewrite ownership when only RSS changes", async () => {
    const file = await ownershipFile();
    let rows = processRows();
    const process = { pid: 100, exited: Promise.resolve(0), kill: () => {} };
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: async () => ({ ok: true as const, rows }),
      minScanIntervalMs: 0,
      runnerPid: 50
    });
    await lifecycle.register(process);
    const persisted = await readFile(file, "utf8");
    rows = rows.map((row) => ({ ...row, rss_bytes: row.rss_bytes + 1_024 }));

    await lifecycle.refresh(process, { mode: "coalesced", reason: "rss_only" });

    expect(await readFile(file, "utf8")).toBe(persisted);
    expect(lifecycle.snapshot()?.processes[0]?.rss_bytes).toBe(17_408);
    expect(lifecycle.metrics()).toMatchObject({
      ownership_persisted_total: 1,
      scan_executed_total: 2,
      scan_unchanged_total: 1
    });
  });

  test("throttles a sequential burst to one trailing scan", async () => {
    const file = await ownershipFile();
    let inspections = 0;
    const process = { pid: 100, exited: Promise.resolve(0), kill: () => {} };
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => { inspections += 1; return processRows(); },
      minScanIntervalMs: 10,
      runnerPid: 50
    });
    await lifecycle.register(process);

    for (let index = 0; index < 100; index += 1) void lifecycle.refresh(process, {
      mode: "coalesced",
      reason: "structural_event"
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(inspections).toBe(2);
    expect(lifecycle.metrics().scan_throttled_total).toBeGreaterThan(0);
  });

  test("falls back to the controlled root handle when a force scan fails", async () => {
    const file = await ownershipFile();
    const kills: string[] = [];
    const diagnostics: string[] = [];
    let fail = false;
    let exit!: (code: number) => void;
    const process = {
      pid: 100,
      exited: new Promise<number>((resolve) => { exit = resolve; }),
      kill: (signal = "SIGTERM") => { kills.push(String(signal)); exit(0); }
    };
    const lifecycle = new CodexProcessGroupLifecycle(file, ["codex", "app-server"], {
      inspect: () => fail ? { ok: false as const, reason_code: "exit_nonzero" as const } : processRows(),
      onDiagnostic: ({ reason_code }) => diagnostics.push(reason_code),
      runnerPid: 50,
      stopGraceMs: 1
    });
    await lifecycle.register(process);
    fail = true;

    await lifecycle.stop(process);

    expect(kills).toEqual(["SIGTERM"]);
    expect(diagnostics).toEqual(["exit_nonzero"]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function processRows(): ProcessTreeEntry[] {
  return [
    { command: "/opt/codex app-server --listen stdio://", pgid: 100, pid: 100, ppid: 50, rss_bytes: 16_384 },
    { command: "node mcp/server.mjs", pgid: 101, pid: 101, ppid: 100, rss_bytes: 8_192 },
    { command: "node mcp/worker.mjs", pgid: 101, pid: 102, ppid: 101, rss_bytes: 4_096 },
    { command: "unrelated", pgid: 200, pid: 200, ppid: 1, rss_bytes: 1_024 }
  ];
}

async function ownershipFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-process-lifecycle-"));
  roots.push(root);
  return join(root, "ownership.json");
}
