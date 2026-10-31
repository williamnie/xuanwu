import type { ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";

import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const MIB = 1024 * 1024;

export function fixtureRows(mainMiB: number, childMiB: number): ProcessTreeEntry[] {
  return [
    row(50, 1, mainMiB, "Mon Jul 20 00:00:00 2026\t/Users/private/runner --token runtime-secret"),
    row(100, 50, childMiB, "Mon Jul 20 01:00:00 2026\t/opt/codex app-server --token runtime-secret")
  ];
}

export function row(pid: number, ppid: number, mib: number, command: string): ProcessTreeEntry {
  return { command, pgid: pid, pid, ppid, rss_bytes: mib * MIB };
}

export function memoryUsage(rssMiB: number): ReturnType<typeof process.memoryUsage> {
  return { arrayBuffers: 3, external: 4, heapTotal: 5, heapUsed: 6, rss: rssMiB * MIB };
}

export function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

export type Snapshot = {
  activity: Record<string, unknown>;
  aggregate: Record<string, unknown>;
  budget: Record<string, unknown>;
  main: Record<string, unknown>;
  measurement: Record<string, unknown>;
  memory_reclaim: Record<string, unknown>;
  recently_exited: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  top_by_rss: Array<Record<string, unknown>>;
  phase: string;
};
