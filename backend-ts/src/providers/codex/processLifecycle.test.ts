import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
