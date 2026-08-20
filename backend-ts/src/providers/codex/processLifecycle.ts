import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CODEX_PROCESS_OWNERSHIP_CONTRACT = "codex-process-group-ownership.v1" as const;
export const DEFAULT_CODEX_PROCESS_STOP_GRACE_MS = 1_000;
export const DEFAULT_CODEX_PROCESS_MIN_SCAN_INTERVAL_MS = 1_000;
const PROCESS_TABLE_MAX_BYTES = 8 * 1024 * 1024;
const PROCESS_TABLE_TIMEOUT_MS = 5_000;

export type ProcessSignal = "SIGKILL" | "SIGTERM";
export type ProcessTreeEntry = { command: string; pgid: number; pid: number; ppid: number; rss_bytes: number };
export type ProcessInspectionFailureReason = "exit_nonzero" | "output_too_large" | "parse_failed" | "spawn_failed";
export type ProcessInspectionResult =
  | { ok: true; rows: ProcessTreeEntry[] }
  | { ok: false; reason_code: ProcessInspectionFailureReason };
export type ProcessRefreshMode = "coalesced" | "force";
export type ProcessRefreshOptions = { mode?: ProcessRefreshMode; reason?: string };
export type ProcessLifecycleMetrics = {
  last_scan_age_ms: number;
  ownership_persisted_total: number;
  scan_executed_total: number;
  scan_failed_total: Record<ProcessInspectionFailureReason, number>;
  scan_requested_total: Record<string, number>;
  scan_throttled_total: number;
  scan_unchanged_total: number;
};
export type CodexProcessOwnership = {
  command: string[];
  contract: typeof CODEX_PROCESS_OWNERSHIP_CONTRACT;
  observed_at: string;
  processes: ProcessTreeEntry[];
  root_pgid: number;
  root_pid: number;
  runner_pid: number;
  started_at: string;
};
export type StaleProcessReconciliation = {
  action: "killed" | "none" | "ownership_mismatch" | "scan_failed";
  killed_process_groups: number[];
  ownership_file: string;
  stale_root_pid: number;
};

type OwnedProcess = { exited: Promise<number>; kill(signal?: string | number): unknown; pid?: number };
type Inspector = () => ProcessInspectionResult | ProcessTreeEntry[] | Promise<ProcessInspectionResult | ProcessTreeEntry[]>;
type ProcessLifecycleOptions = {
  inspect?: Inspector;
  minScanIntervalMs?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  onDiagnostic?: (input: { reason_code: ProcessInspectionFailureReason; reason: string }) => void;
  runnerPid?: number;
  signalGroup?: (pgid: number, signal: ProcessSignal) => void;
  sleep?: (ms: number) => Promise<void>;
  stopGraceMs?: number;
};
type RefreshOperation = { generation: number; phase: "queued" | "scanning"; promise: Promise<void>; rootPID: number };

export class CodexProcessGroupLifecycle {
  private fileOperation = Promise.resolve();
  private generation = 0;
  private lastInspection?: ProcessInspectionResult;
  private lastScanMonotonic = Number.NEGATIVE_INFINITY;
  private ownership?: CodexProcessOwnership;
  private refreshOperation?: RefreshOperation;
  private trailing?: { generation: number; promise: Promise<void>; resolve: () => void; rootPID: number; timer: ReturnType<typeof setTimeout> };
  private trailingRequested = false;
  private readonly metricState: ProcessLifecycleMetrics = {
    last_scan_age_ms: 0,
    ownership_persisted_total: 0,
    scan_executed_total: 0,
    scan_failed_total: { exit_nonzero: 0, output_too_large: 0, parse_failed: 0, spawn_failed: 0 },
    scan_requested_total: {},
    scan_throttled_total: 0,
    scan_unchanged_total: 0
  };

  constructor(
    private readonly ownershipFile: string,
    private readonly command: string[],
    private readonly options: ProcessLifecycleOptions = {}
  ) {}

  async register(process: OwnedProcess): Promise<void> {
    const rootPID = positiveInteger(process.pid);
    if (rootPID === 0) return;
    this.generation += 1;
    this.cancelTrailing();
    this.incrementRequested("force", "register");
    const generation = this.generation;
    const result = await this.inspect("register");
    if (generation !== this.generation) return;
    const now = this.now().toISOString();
    const processes = result.ok ? ownedTree(result.rows, rootPID) : [];
    this.ownership = {
      command: [...this.command],
      contract: CODEX_PROCESS_OWNERSHIP_CONTRACT,
      observed_at: now,
      processes: processes.length > 0 ? processes : [fallbackRoot(rootPID, this.command)],
      root_pgid: rootPID,
      root_pid: rootPID,
      runner_pid: this.options.runnerPid ?? globalThis.process.pid,
      started_at: now
    };
    await this.persist();
  }

  async refresh(process: OwnedProcess | undefined, input: ProcessRefreshOptions = {}): Promise<void> {
    const rootPID = positiveInteger(process?.pid);
    const mode = input.mode ?? "coalesced";
    const reason = boundedReason(input.reason ?? "unspecified");
    this.incrementRequested(mode, reason);
    if (!this.ownership || rootPID === 0 || this.ownership.root_pid !== rootPID) return;
    const generation = this.generation;
    const active = this.refreshOperation;
    if (active && active.rootPID === rootPID && active.generation === generation) {
      if (mode === "force") {
        await active.promise;
        if (this.matches(rootPID, generation)) await this.startRefresh(rootPID, generation);
        return;
      }
      const needsTrailing = active.phase === "scanning";
      if (needsTrailing) this.trailingRequested = true;
      await active.promise;
      if (needsTrailing && this.matches(rootPID, generation)) await this.scheduleTrailing(rootPID, generation);
      return;
    }
    if (mode === "coalesced" && this.remainingThrottleMs() > 0) {
      this.metricState.scan_throttled_total += 1;
      await this.scheduleTrailing(rootPID, generation);
      return;
    }
    if (mode === "force") this.cancelTrailing();
    await this.startRefresh(rootPID, generation);
  }

  async stop(process: OwnedProcess): Promise<void> {
    const rootPID = positiveInteger(process.pid);
    await this.refresh(process, { mode: "force", reason: "before_signal" });
    const ownership = this.ownership;
    if (!ownership || ownership.root_pid !== rootPID || !this.lastInspection?.ok) {
      await this.stopRootHandle(process, rootPID, ownership);
      return;
    }
    const groups = ownedGroupsStillMatching(ownership, this.lastInspection.rows);
    if (groups.length === 0) {
      await this.stopRootHandle(process, rootPID, ownership);
      return;
    }
    for (const pgid of groups) this.signalGroup(pgid, "SIGTERM");
    const exited = await exitsWithin(process.exited, this.stopGraceMs());
    if (!exited) {
      await this.refresh(process, { mode: "force", reason: "before_sigkill" });
      if (this.lastInspection?.ok) {
        for (const pgid of ownedGroupsStillMatching(ownership, this.lastInspection.rows)) this.signalGroup(pgid, "SIGKILL");
      } else process.kill("SIGKILL");
      await settleExit(process.exited, this.stopGraceMs());
    }
    await this.clearOwnership(rootPID);
  }

  async processExited(process: OwnedProcess): Promise<void> {
    const rootPID = positiveInteger(process.pid);
    await this.refresh(process, { mode: "force", reason: "process_exit" });
    const ownership = this.ownership;
    if (!ownership || ownership.root_pid !== rootPID) return;
    if (this.lastInspection?.ok) {
      const groups = ownedGroupsStillMatching(ownership, this.lastInspection.rows);
      for (const pgid of groups) this.signalGroup(pgid, "SIGTERM");
      await (this.options.sleep ?? sleep)(this.stopGraceMs());
      const afterTerm = await this.inspect("exit_after_term");
      if (afterTerm.ok) {
        for (const pgid of ownedGroupsStillMatching(ownership, afterTerm.rows)) this.signalGroup(pgid, "SIGKILL");
      }
    }
    await this.clearOwnership(rootPID);
  }

  snapshot(): CodexProcessOwnership | undefined { return this.ownership ? structuredClone(this.ownership) : undefined; }
  metrics(): ProcessLifecycleMetrics {
    return {
      ...structuredClone(this.metricState),
      last_scan_age_ms: Number.isFinite(this.lastScanMonotonic) ? Math.max(0, this.monotonicNow() - this.lastScanMonotonic) : 0
    };
  }

  private async startRefresh(rootPID: number, generation: number): Promise<void> {
    if (!this.matches(rootPID, generation)) return;
    const current = this.refreshOperation;
    if (current && current.rootPID === rootPID && current.generation === generation) return await current.promise;
    let operation!: RefreshOperation;
    const promise = Promise.resolve().then(async () => {
      operation.phase = "scanning";
      await this.performRefresh(rootPID, generation);
    });
    operation = { generation, phase: "queued", promise, rootPID };
    this.refreshOperation = operation;
    try { await promise; } finally {
      if (this.refreshOperation === operation) this.refreshOperation = undefined;
      if (this.trailingRequested && this.matches(rootPID, generation)) {
        this.trailingRequested = false;
        void this.scheduleTrailing(rootPID, generation);
      }
    }
  }

  private async performRefresh(rootPID: number, generation: number): Promise<void> {
    const ownership = this.ownership;
    if (!ownership || !this.matches(rootPID, generation)) return;
    const result = await this.inspect("refresh");
    if (!this.matches(rootPID, generation) || !result.ok) return;
    const processes = ownedTree(result.rows, rootPID);
    if (processes.length === 0) return;
    if (identityFingerprint(processes) === identityFingerprint(ownership.processes)) {
      this.metricState.scan_unchanged_total += 1;
      this.ownership = { ...ownership, processes };
      return;
    }
    const refreshed = { ...ownership, observed_at: this.now().toISOString(), processes };
    this.ownership = refreshed;
    await this.persist(refreshed);
  }

  private scheduleTrailing(rootPID: number, generation: number): Promise<void> {
    const existing = this.trailing;
    if (existing && existing.rootPID === rootPID && existing.generation === generation) return existing.promise;
    this.cancelTrailing();
    const waitMs = Math.max(0, this.remainingThrottleMs());
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
    const timer = setTimeout(() => {
      if (this.trailing?.promise === promise) this.trailing = undefined;
      void this.startRefresh(rootPID, generation).finally(resolvePromise);
    }, waitMs);
    this.trailing = { generation, promise, resolve: resolvePromise, rootPID, timer };
    return promise;
  }

  private cancelTrailing(): void {
    const trailing = this.trailing;
    if (!trailing) return;
    clearTimeout(trailing.timer);
    this.trailing = undefined;
    trailing.resolve();
  }

  private async inspect(reason: string): Promise<ProcessInspectionResult> {
    this.metricState.scan_executed_total += 1;
    let result: ProcessInspectionResult;
    try {
      const value = await (this.options.inspect ?? inspectProcessTable)();
      result = Array.isArray(value) ? { ok: true, rows: value } : value;
    } catch { result = { ok: false, reason_code: "spawn_failed" }; }
    this.lastScanMonotonic = this.monotonicNow();
    this.lastInspection = result;
    if (!result.ok) {
      this.metricState.scan_failed_total[result.reason_code] += 1;
      this.options.onDiagnostic?.({ reason_code: result.reason_code, reason: boundedReason(reason) });
    }
    return result;
  }

  private async persist(ownership = this.ownership): Promise<void> {
    if (!this.ownershipFile || !ownership) return;
    const serialized = `${JSON.stringify(ownership)}\n`;
    await this.enqueueFileOperation(async () => {
      await mkdir(dirname(this.ownershipFile), { recursive: true });
      const temporary = `${this.ownershipFile}.${globalThis.process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, "utf8");
        await chmod(temporary, 0o600);
        await rename(temporary, this.ownershipFile);
        this.metricState.ownership_persisted_total += 1;
      } finally { await rm(temporary, { force: true }); }
    });
  }

  private async clearOwnership(rootPID: number): Promise<void> {
    if (this.ownership?.root_pid !== rootPID) return;
    this.generation += 1;
    this.cancelTrailing();
    this.ownership = undefined;
    await this.enqueueFileOperation(() => removeOwnershipFile(this.ownershipFile));
  }

  private async stopRootHandle(process: OwnedProcess, rootPID: number, ownership?: CodexProcessOwnership): Promise<void> {
    process.kill("SIGTERM");
    if (!await exitsWithin(process.exited, this.stopGraceMs())) {
      process.kill("SIGKILL");
      await settleExit(process.exited, this.stopGraceMs());
    }
    if (this.ownership?.root_pid === rootPID || (!this.ownership && !ownership)) await this.clearOwnership(rootPID);
  }

  private async enqueueFileOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.fileOperation.then(operation, operation);
    this.fileOperation = queued.catch(() => {});
    await queued;
  }
  private incrementRequested(mode: ProcessRefreshMode, reason: string): void {
    const key = `${mode}:${reason}`;
    this.metricState.scan_requested_total[key] = (this.metricState.scan_requested_total[key] ?? 0) + 1;
  }
  private matches(rootPID: number, generation: number): boolean { return this.generation === generation && this.ownership?.root_pid === rootPID; }
  private remainingThrottleMs(): number { return this.minScanIntervalMs() - (this.monotonicNow() - this.lastScanMonotonic); }
  private minScanIntervalMs(): number {
    const value = this.options.minScanIntervalMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CODEX_PROCESS_MIN_SCAN_INTERVAL_MS;
  }
  private monotonicNow(): number { return this.options.monotonicNow?.() ?? performance.now(); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private stopGraceMs(): number { return positiveInteger(this.options.stopGraceMs) || DEFAULT_CODEX_PROCESS_STOP_GRACE_MS; }
  private signalGroup(pgid: number, signal: ProcessSignal): void { (this.options.signalGroup ?? signalProcessGroup)(pgid, signal); }
}

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

async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
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

function ownedTree(rows: ProcessTreeEntry[], rootPID: number): ProcessTreeEntry[] {
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
function identityFingerprint(rows: ProcessTreeEntry[]): string {
  return JSON.stringify(rows.map(({ command, pgid, pid, ppid }) => ({ command, pgid, pid, ppid })));
}
function ownedGroupsStillMatching(ownership: CodexProcessOwnership, liveRows: ProcessTreeEntry[]): number[] {
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
function fallbackRoot(rootPID: number, command: string[]): ProcessTreeEntry {
  return { command: command.join(" "), pgid: rootPID, pid: rootPID, ppid: 0, rss_bytes: 0 };
}
function parseProcessRow(line: string): ProcessTreeEntry | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return;
  return { command: match[5], pgid: Number(match[3]), pid: Number(match[1]), ppid: Number(match[2]), rss_bytes: Number(match[4]) * 1024 };
}
async function readOwnershipFile(path: string): Promise<CodexProcessOwnership | undefined> {
  if (!path) return;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CodexProcessOwnership>;
    if (parsed.contract !== CODEX_PROCESS_OWNERSHIP_CONTRACT || !Array.isArray(parsed.processes)) return;
    if (positiveInteger(parsed.root_pid) === 0 || positiveInteger(parsed.root_pgid) === 0) return;
    return parsed as CodexProcessOwnership;
  } catch { return; }
}
async function removeOwnershipFile(path: string): Promise<void> { if (path) await rm(path, { force: true }); }
async function exitsWithin(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([exited.then(() => true, () => true), sleep(timeoutMs).then(() => false)]);
}
async function settleExit(exited: Promise<number>, timeoutMs: number): Promise<void> { await Promise.race([exited.catch(() => 1), sleep(timeoutMs)]); }
function normalizeInspection(value: ProcessInspectionResult | ProcessTreeEntry[]): ProcessInspectionResult {
  return Array.isArray(value) ? { ok: true, rows: value } : value;
}
async function safeInspect(inspect: Inspector): Promise<ProcessInspectionResult> {
  try { return normalizeInspection(await inspect()); }
  catch { return { ok: false, reason_code: "spawn_failed" }; }
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positiveInteger(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0; }
function boundedReason(value: string): string { return value.trim().slice(0, 64) || "unspecified"; }
function signalProcessGroup(pgid: number, signal: ProcessSignal): void {
  try { globalThis.process.kill(-pgid, signal); } catch (error) { if (!isMissingProcess(error)) throw error; }
}
function isMissingProcess(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
