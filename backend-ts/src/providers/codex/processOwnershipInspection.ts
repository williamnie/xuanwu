import { readFile, rm } from "node:fs/promises";
import { ProcessLifecycleOptions, StaleProcessReconciliation, DEFAULT_CODEX_PROCESS_STOP_GRACE_MS, ProcessInspectionResult, PROCESS_TABLE_TIMEOUT_MS, PROCESS_TABLE_MAX_BYTES, ProcessTreeEntry, CodexProcessOwnership, CODEX_PROCESS_OWNERSHIP_CONTRACT, Inspector, ProcessSignal } from "./processOwnershipModel.ts";

export async function reconcileStaleCodexProcessOwnership(
  ownershipFile: string,
  options: ProcessLifecycleOptions = {}
): Promise<StaleProcessReconciliation> {
  const base = { killed_process_groups: [] as number[], ownership_file: ownershipFile, stale_root_pid: 0 };
  const ownership = await readOwnershipFile(ownershipFile);
  if (!ownership) return { ...base, action: "none" };
  base.stale_root_pid = ownership.root_pid;
  if (ownership.runner_pid === (options.runnerPid ?? globalThis.process.pid)) return { ...base, action: "none" };
  const first = await safeInspect(options.inspect ?? inspectProcessTable);
  if (!first.ok) return { ...base, action: "scan_failed" };
  const groups = ownedGroupsStillMatching(ownership, first.rows);
  if (groups.length === 0) {
    await removeOwnershipFile(ownershipFile);
    return { ...base, action: "ownership_mismatch" };
  }
  const signalGroup = options.signalGroup ?? signalProcessGroup;
  for (const pgid of groups) signalGroup(pgid, "SIGTERM");
  await (options.sleep ?? sleep)(positiveInteger(options.stopGraceMs) || DEFAULT_CODEX_PROCESS_STOP_GRACE_MS);
  const second = await safeInspect(options.inspect ?? inspectProcessTable);
  if (!second.ok) return { ...base, action: "scan_failed" };
  for (const pgid of ownedGroupsStillMatching(ownership, second.rows)) signalGroup(pgid, "SIGKILL");
  await removeOwnershipFile(ownershipFile);
  return { ...base, action: "killed", killed_process_groups: groups };
}

export async function inspectProcessTable(): Promise<ProcessInspectionResult> {
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,rss=,command="], { stderr: "ignore", stdout: "pipe" });
  } catch { return { ok: false, reason_code: "spawn_failed" }; }
  const timeout = setTimeout(() => process.kill("SIGKILL"), PROCESS_TABLE_TIMEOUT_MS);
  try {
    const output = await readBounded(process.stdout, PROCESS_TABLE_MAX_BYTES);
    const exitCode = await process.exited;
    if (output === undefined) return { ok: false, reason_code: "output_too_large" };
    if (exitCode !== 0) return { ok: false, reason_code: "exit_nonzero" };
    const rows: ProcessTreeEntry[] = [];
    for (const line of new TextDecoder().decode(output).split("\n")) {
      if (line.trim() === "") continue;
      const row = parseProcessRow(line);
      if (!row) return { ok: false, reason_code: "parse_failed" };
      rows.push(row);
    }
    return { ok: true, rows };
  } catch { return { ok: false, reason_code: "spawn_failed" }; }
  finally { clearTimeout(timeout); }
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) return;
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function ownedTree(rows: ProcessTreeEntry[], rootPID: number): ProcessTreeEntry[] {
  const root = rows.find((row) => row.pid === rootPID);
  if (!root || root.pgid !== rootPID) return [];
  const selected = new Map<number, ProcessTreeEntry>([[root.pid, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.pid) || !selected.has(row.ppid)) continue;
      selected.set(row.pid, row);
      changed = true;
    }
  }
  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

export function identityFingerprint(rows: ProcessTreeEntry[]): string {
  return JSON.stringify(rows.map(({ command, pgid, pid, ppid }) => ({ command, pgid, pid, ppid })));
}

export function ownedGroupsStillMatching(ownership: CodexProcessOwnership, liveRows: ProcessTreeEntry[]): number[] {
  const live = new Map(liveRows.map((row) => [row.pid, row]));
  const expectedRoot = ownership.processes.find((row) => row.pid === ownership.root_pid);
  const currentRoot = live.get(ownership.root_pid);
  if (currentRoot && (!expectedRoot || currentRoot.pgid !== expectedRoot.pgid || currentRoot.command !== expectedRoot.command)) return [];
  const groups = new Set<number>();
  for (const expected of ownership.processes) {
    const current = live.get(expected.pid);
    if (!current || current.pgid !== expected.pgid || current.command !== expected.command) continue;
    groups.add(expected.pgid);
  }
  return [...groups].filter((pgid) => pgid > 1).sort((left, right) => right - left);
}

export function fallbackRoot(rootPID: number, command: string[]): ProcessTreeEntry {
  return { command: command.join(" "), pgid: rootPID, pid: rootPID, ppid: 0, rss_bytes: 0 };
}

export function parseProcessRow(line: string): ProcessTreeEntry | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return;
  return { command: match[5], pgid: Number(match[3]), pid: Number(match[1]), ppid: Number(match[2]), rss_bytes: Number(match[4]) * 1024 };
}

export async function readOwnershipFile(path: string): Promise<CodexProcessOwnership | undefined> {
  if (!path) return;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CodexProcessOwnership>;
    if (parsed.contract !== CODEX_PROCESS_OWNERSHIP_CONTRACT || !Array.isArray(parsed.processes)) return;
    if (positiveInteger(parsed.root_pid) === 0 || positiveInteger(parsed.root_pgid) === 0) return;
    return parsed as CodexProcessOwnership;
  } catch { return; }
}

export async function removeOwnershipFile(path: string): Promise<void> { if (path) await rm(path, { force: true }); }

export async function exitsWithin(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([exited.then(() => true, () => true), sleep(timeoutMs).then(() => false)]);
}

export async function settleExit(exited: Promise<number>, timeoutMs: number): Promise<void> { await Promise.race([exited.catch(() => 1), sleep(timeoutMs)]); }

export function normalizeInspection(value: ProcessInspectionResult | ProcessTreeEntry[]): ProcessInspectionResult {
  return Array.isArray(value) ? { ok: true, rows: value } : value;
}

export async function safeInspect(inspect: Inspector): Promise<ProcessInspectionResult> {
  try { return normalizeInspection(await inspect()); }
  catch { return { ok: false, reason_code: "spawn_failed" }; }
}

export function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function positiveInteger(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0; }

export function boundedReason(value: string): string { return value.trim().slice(0, 64) || "unspecified"; }

export function signalProcessGroup(pgid: number, signal: ProcessSignal): void {
  try { globalThis.process.kill(-pgid, signal); } catch (error) { if (!isMissingProcess(error)) throw error; }
}

export function isMissingProcess(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
