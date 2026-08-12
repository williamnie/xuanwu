import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CODEX_PROCESS_OWNERSHIP_CONTRACT = "codex-process-group-ownership.v1" as const;
export const DEFAULT_CODEX_PROCESS_STOP_GRACE_MS = 1_000;

export type ProcessSignal = "SIGKILL" | "SIGTERM";
export type ProcessTreeEntry = { command: string; pgid: number; pid: number; ppid: number; rss_bytes: number };
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
  action: "killed" | "none" | "ownership_mismatch";
  killed_process_groups: number[];
  ownership_file: string;
  stale_root_pid: number;
};

type OwnedProcess = { exited: Promise<number>; kill(signal?: string | number): unknown; pid?: number };
type ProcessLifecycleOptions = {
  inspect?: () => ProcessTreeEntry[];
  now?: () => Date;
  runnerPid?: number;
  signalGroup?: (pgid: number, signal: ProcessSignal) => void;
  sleep?: (ms: number) => Promise<void>;
  stopGraceMs?: number;
};

export class CodexProcessGroupLifecycle {
  private fileOperation = Promise.resolve();
  private ownership?: CodexProcessOwnership;
  private refreshOperation?: { promise: Promise<void>; rootPID: number };
  private refreshRequested = false;

  constructor(
    private readonly ownershipFile: string,
    private readonly command: string[],
    private readonly options: ProcessLifecycleOptions = {}
  ) {}

  async register(process: OwnedProcess): Promise<void> {
    const rootPID = positiveInteger(process.pid);
    if (rootPID === 0) return;
    const now = this.now().toISOString();
    this.ownership = {
      command: [...this.command],
      contract: CODEX_PROCESS_OWNERSHIP_CONTRACT,
      observed_at: now,
      processes: this.ownedTree(rootPID),
      root_pgid: rootPID,
      root_pid: rootPID,
      runner_pid: this.options.runnerPid ?? globalThis.process.pid,
      started_at: now
    };
    await this.persist();
  }

  async refresh(process: OwnedProcess | undefined): Promise<void> {
    const rootPID = positiveInteger(process?.pid);
    if (!this.ownership || rootPID === 0 || this.ownership.root_pid !== rootPID) return;
    const active = this.refreshOperation;
    if (active) {
      if (active.rootPID === rootPID) this.refreshRequested = true;
      await active.promise;
      if (active.rootPID === rootPID) return;
      await this.refresh(process);
      return;
    }
    this.refreshRequested = true;
    const promise = this.drainRefresh(rootPID);
    this.refreshOperation = { promise, rootPID };
    try {
      await promise;
    } finally {
      if (this.refreshOperation?.promise === promise) this.refreshOperation = undefined;
    }
  }

  private async drainRefresh(rootPID: number): Promise<void> {
    // Let notifications drained from the same stdout chunk share one process-table scan.
    await Promise.resolve();
    do {
      this.refreshRequested = false;
      await this.performRefresh(rootPID);
    } while (this.refreshRequested && this.ownership?.root_pid === rootPID);
  }

  private async performRefresh(rootPID: number): Promise<void> {
    const ownership = this.ownership;
    if (!ownership || ownership.root_pid !== rootPID) return;
    const processes = this.ownedTree(rootPID);
    if (processes.length === 0) return;
    const refreshed = {
      ...ownership,
      observed_at: this.now().toISOString(),
      processes
    };
    this.ownership = refreshed;
    await this.persist(refreshed);
  }

  async stop(process: OwnedProcess): Promise<void> {
    await this.refresh(process);
    const ownership = this.ownership;
    const rootPID = positiveInteger(process.pid);
    if (!ownership || ownership.root_pid !== rootPID || ownership.processes.length === 0
      || ownedGroupsStillMatching(ownership, this.inspect()).length === 0) {
      process.kill("SIGTERM");
      await boundedExit(process.exited, this.stopGraceMs(), () => process.kill("SIGKILL"));
      if (this.ownership?.root_pid === rootPID || (!this.ownership && !ownership)) {
        this.ownership = undefined;
        await this.removePersistedOwnership();
      }
      return;
    }
    await terminateOwnedGroups(ownership, this.runtimeOptions());
    await boundedExit(process.exited, this.stopGraceMs(), () => this.signalOwned(ownership, "SIGKILL"));
    if (this.ownership?.root_pid !== rootPID) return;
    this.ownership = undefined;
    await this.removePersistedOwnership();
  }

  async processExited(process: OwnedProcess): Promise<void> {
    await this.refresh(process);
    const ownership = this.ownership;
    if (!ownership || ownership.root_pid !== positiveInteger(process.pid)) return;
    if (ownership) await terminateOwnedGroups(ownership, this.runtimeOptions());
    if (this.ownership?.root_pid !== ownership.root_pid) return;
    this.ownership = undefined;
    await this.removePersistedOwnership();
  }

  snapshot(): CodexProcessOwnership | undefined {
    return this.ownership ? structuredClone(this.ownership) : undefined;
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
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  private async removePersistedOwnership(): Promise<void> {
    await this.enqueueFileOperation(() => removeOwnershipFile(this.ownershipFile));
  }

  private async enqueueFileOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.fileOperation.then(operation, operation);
    this.fileOperation = queued.catch(() => {});
    await queued;
  }

  private ownedTree(rootPID: number): ProcessTreeEntry[] {
    return ownedTree(this.inspect(), rootPID);
  }

  private inspect(): ProcessTreeEntry[] {
    return (this.options.inspect ?? inspectProcessTable)();
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private stopGraceMs(): number { return positiveInteger(this.options.stopGraceMs) || DEFAULT_CODEX_PROCESS_STOP_GRACE_MS; }
  private signalOwned(ownership: CodexProcessOwnership, signal: ProcessSignal): void {
    for (const pgid of ownedGroupsStillMatching(ownership, this.inspect())) this.signalGroup(pgid, signal);
  }
  private signalGroup(pgid: number, signal: ProcessSignal): void {
    (this.options.signalGroup ?? signalProcessGroup)(pgid, signal);
  }
  private runtimeOptions(): Required<Pick<ProcessLifecycleOptions, "inspect" | "signalGroup" | "sleep">> & { stopGraceMs: number } {
    return {
      inspect: () => this.inspect(),
      signalGroup: (pgid, signal) => this.signalGroup(pgid, signal),
      sleep: this.options.sleep ?? sleep,
      stopGraceMs: this.stopGraceMs()
    };
  }
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
  const inspect = options.inspect ?? inspectProcessTable;
  const groups = ownedGroupsStillMatching(ownership, inspect());
  if (groups.length === 0) {
    await removeOwnershipFile(ownershipFile);
    return { ...base, action: "ownership_mismatch" };
  }
  const signalGroup = options.signalGroup ?? signalProcessGroup;
  for (const pgid of groups) signalGroup(pgid, "SIGTERM");
  await (options.sleep ?? sleep)(positiveInteger(options.stopGraceMs) || DEFAULT_CODEX_PROCESS_STOP_GRACE_MS);
  const remaining = ownedGroupsStillMatching(ownership, inspect());
  for (const pgid of remaining) signalGroup(pgid, "SIGKILL");
  await removeOwnershipFile(ownershipFile);
  return { ...base, action: "killed", killed_process_groups: groups };
}

async function terminateOwnedGroups(
  ownership: CodexProcessOwnership,
  options: Required<Pick<ProcessLifecycleOptions, "inspect" | "signalGroup" | "sleep">> & { stopGraceMs: number }
): Promise<void> {
  const groups = ownedGroupsStillMatching(ownership, options.inspect());
  for (const pgid of groups) options.signalGroup(pgid, "SIGTERM");
  await options.sleep(options.stopGraceMs);
  for (const pgid of ownedGroupsStillMatching(ownership, options.inspect())) options.signalGroup(pgid, "SIGKILL");
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

function ownedGroupsStillMatching(ownership: CodexProcessOwnership, liveRows: ProcessTreeEntry[]): number[] {
  const live = new Map(liveRows.map((row) => [row.pid, row]));
  const expectedRoot = ownership.processes.find((row) => row.pid === ownership.root_pid);
  const currentRoot = live.get(ownership.root_pid);
  if (currentRoot && (!expectedRoot || currentRoot.pgid !== expectedRoot.pgid || currentRoot.command !== expectedRoot.command)) {
    return [];
  }
  const groups = new Set<number>();
  for (const expected of ownership.processes) {
    const current = live.get(expected.pid);
    if (!current || current.pgid !== expected.pgid || current.command !== expected.command) continue;
    groups.add(expected.pgid);
  }
  return [...groups].filter((pgid) => pgid > 1).sort((left, right) => right - left);
}

export function inspectProcessTable(): ProcessTreeEntry[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,rss=,command="], { stderr: "ignore", stdout: "pipe" });
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).split("\n").map(parseProcessRow).filter(isProcessTreeEntry);
}

function parseProcessRow(line: string): ProcessTreeEntry | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return;
  return {
    command: match[5],
    pgid: Number(match[3]),
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rss_bytes: Number(match[4]) * 1024
  };
}

function isProcessTreeEntry(value: ProcessTreeEntry | undefined): value is ProcessTreeEntry { return value !== undefined; }

function signalProcessGroup(pgid: number, signal: ProcessSignal): void {
  try { globalThis.process.kill(-pgid, signal); } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function readOwnershipFile(path: string): Promise<CodexProcessOwnership | undefined> {
  if (!path) return;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CodexProcessOwnership>;
    if (parsed.contract !== CODEX_PROCESS_OWNERSHIP_CONTRACT || !Array.isArray(parsed.processes)) return;
    if (positiveInteger(parsed.root_pid) === 0 || positiveInteger(parsed.root_pgid) === 0) return;
    return parsed as CodexProcessOwnership;
  } catch (error) {
    if (isMissingFile(error)) return;
    return;
  }
}

async function removeOwnershipFile(path: string): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}

async function boundedExit(exited: Promise<number>, timeoutMs: number, force: () => unknown): Promise<void> {
  const exitedInTime = await Promise.race([exited.then(() => true, () => true), sleep(timeoutMs).then(() => false)]);
  if (exitedInTime) return;
  force();
  await Promise.race([exited.catch(() => 1), sleep(timeoutMs)]);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positiveInteger(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0; }
function isMissingFile(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function isMissingProcess(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
