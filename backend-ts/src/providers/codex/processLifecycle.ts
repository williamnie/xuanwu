import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProcessInspectionResult, CodexProcessOwnership, RefreshOperation, ProcessLifecycleMetrics, ProcessLifecycleOptions, OwnedProcess, CODEX_PROCESS_OWNERSHIP_CONTRACT, ProcessRefreshOptions, ProcessRefreshMode, DEFAULT_CODEX_PROCESS_MIN_SCAN_INTERVAL_MS, DEFAULT_CODEX_PROCESS_STOP_GRACE_MS, ProcessSignal } from "./processOwnershipModel.ts";
import { positiveInteger, ownedTree, fallbackRoot, boundedReason, ownedGroupsStillMatching, exitsWithin, settleExit, sleep, identityFingerprint, inspectProcessTable, removeOwnershipFile, signalProcessGroup } from "./processOwnershipInspection.ts";

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

export { CODEX_PROCESS_OWNERSHIP_CONTRACT, type ProcessSignal, type ProcessTreeEntry, type CodexProcessOwnership, type StaleProcessReconciliation } from "./processOwnershipModel.ts";
export { reconcileStaleCodexProcessOwnership } from "./processOwnershipInspection.ts";
