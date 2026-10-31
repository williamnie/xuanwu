import type { ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { PROCESS_GROUP_MEMORY_CONTRACT, PROCESS_GROUP_MEMORY_FRESHNESS_MS, PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS, PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS, PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS, PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS, PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS } from './processGroupMemory.model.ts';
import type { ProcessMemoryPhase, ObservedProcess, ProcessGroupMemoryOptions, ProcessMemoryUsage } from './processGroupMemory.model.ts';
import { percentile, positiveBytes, clonePublicSnapshot } from "./processGroupMemory.values.ts";
import { roleSummaries, publicProcesses, descendantTree, isMemoryProbe, safeOwner, processStartedAt, genericOwner, processRole, inspectMemoryProcessTable } from './processGroupMemory.processes.ts';

import { MemoryFootprintProbe } from './processGroupMemory.footprint.ts';
import { MemoryBudgetTracker } from './processGroupMemory.budget.ts';

export class ProcessGroupMemoryObserver {
  private history: Array<{ phase: ProcessMemoryPhase; rss_bytes: number; sampled_at: string }> = [];

  private idleReclaimPending = false;

  private lastReclaimedAt?: number;

  private maintenanceInFlight = 0;

  private maintenanceLastActivityAt = "";

  private lastProcesses = new Map<string, ObservedProcess & { last_seen_at: string; peak_rss_bytes: number }>();

  private recentExited: Array<Record<string, unknown>> = [];

  private reclaimStatus: "completed" | "disabled" | "failed" | "never" | "throttled" = "never";

  private sampleValue?: Record<string, unknown>;

  private timer?: ReturnType<typeof setInterval>;

  private readonly footprintProbe: MemoryFootprintProbe;
  private readonly budgetTracker: MemoryBudgetTracker;

  constructor(private readonly options: ProcessGroupMemoryOptions = {}) {
    this.footprintProbe = new MemoryFootprintProbe(options,
      () => this.observedTree(this.inspect(), this.now()), () => this.runnerPid(), () => this.now());
    this.budgetTracker = new MemoryBudgetTracker(options, () => this.sampleIntervalMs(), () => this.now());
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runMaintenance<T>(operation: () => T | Promise<T>): Promise<T> {
    this.maintenanceInFlight += 1;
    this.maintenanceLastActivityAt = this.now().toISOString();
    try {
      return await operation();
    } finally {
      this.maintenanceInFlight = Math.max(0, this.maintenanceInFlight - 1);
      this.maintenanceLastActivityAt = this.now().toISOString();
    }
  }

  sample(): Record<string, unknown> {
    const now = this.now();
    const rows = this.observedTree(this.inspect(), now);
    const activity = this.activity(now);
    const phase = this.phase(rows, activity.active);
    if (phase === "run") this.idleReclaimPending = true;
    if (phase === "idle" && this.idleReclaimPending) {
      this.reclaimIdleMemory(now);
      this.idleReclaimPending = false;
    }
    const memory = this.memoryUsage();
    const groupRSS = rows.reduce((total, row) => total + row.rss_bytes, 0);
    if (activity.workloadActive) this.budgetTracker.lastRunObservedAt = now.getTime();
    this.history.push({ phase, rss_bytes: groupRSS, sampled_at: now.toISOString() });
    if (this.history.length > 1_800) this.history.splice(0, this.history.length - 1_800);
    this.trackExited(rows, now);
    const phaseRSS = this.history.filter((item) => item.phase === phase).map((item) => item.rss_bytes);
    const p95RSS = percentile(phaseRSS, 0.95);
    if (phase === "idle" && this.budgetTracker.lastRunObservedAt === undefined) {
      this.budgetTracker.idleBaselineBytes = percentile(phaseRSS.slice(-60), 0.5);
    }
    const main = rows.find((row) => row.pid === this.runnerPid());
    const budgetMeasurement = this.footprintProbe.measurement(rows, p95RSS, main?.rss_bytes ?? memory.rss, now);
    const budget = this.budgetTracker.status(phase, budgetMeasurement, p95RSS, main?.rss_bytes ?? memory.rss, groupRSS, now, this.footprintProbe.attempted);
    const roles = roleSummaries(rows);
    const sampledAt = now.toISOString();
    this.sampleValue = {
      contract: PROCESS_GROUP_MEMORY_CONTRACT,
      sampled_at: sampledAt,
      freshness: { age_ms: 0, stale_after_ms: PROCESS_GROUP_MEMORY_FRESHNESS_MS, status: "fresh" },
      phase,
      activity: activity.public,
      aggregate: {
        footprint_bytes: positiveBytes(this.footprintProbe.value?.bytes),
        footprint_main_bytes: positiveBytes(this.footprintProbe.value?.main_bytes),
        footprint_observed_at: this.footprintProbe.value?.observed_at ?? "",
        footprint_process_count: this.footprintProbe.value?.process_count ?? 0,
        process_count: rows.length,
        rss_bytes: groupRSS,
        rss_p95_bytes: p95RSS,
        rss_sample_count: phaseRSS.length
      },
      main: {
        array_buffers_bytes: memory.arrayBuffers,
        external_bytes: memory.external,
        heap_total_bytes: memory.heapTotal,
        heap_used_bytes: memory.heapUsed,
        owner: "runner",
        pid: this.runnerPid(),
        process_rss_bytes: memory.rss,
        ps_rss_bytes: main?.rss_bytes ?? null,
        role: "runner"
      },
      roles,
      top_by_rss: publicProcesses([...rows].sort((left, right) => right.rss_bytes - left.rss_bytes).slice(0, 10)),
      recently_exited: this.recentExited.slice(-10),
      budget,
      measurement: {
        physical_memory_probe: this.options.footprint === false ? "disabled" : this.footprintProbe.attempted ? "ready" : "pending",
        source: budget.measurement_source
      },
      memory_reclaim: this.memoryReclaimSnapshot(now),
      metric_definitions: PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS
    };
    this.budgetTracker.alert(phase, budget, rows, this.sampleValue);
    this.footprintProbe.refresh(rows, now);
    return this.snapshot();
  }

  snapshot(): Record<string, unknown> {
    if (!this.sampleValue) return this.sample();
    const sampledAt = Date.parse(String(this.sampleValue.sampled_at ?? ""));
    const age = Number.isFinite(sampledAt) ? Math.max(0, this.now().getTime() - sampledAt) : Number.MAX_SAFE_INTEGER;
    return {
      ...clonePublicSnapshot(this.sampleValue),
      freshness: {
        age_ms: age,
        stale_after_ms: PROCESS_GROUP_MEMORY_FRESHNESS_MS,
        status: age <= PROCESS_GROUP_MEMORY_FRESHNESS_MS ? "fresh" : "stale"
      }
    };
  }

  private observedTree(allRows: ProcessTreeEntry[], now: Date): ObservedProcess[] {
    const rootPID = this.runnerPid();
    const tree = descendantTree(allRows.filter((row) => !isMemoryProbe(row.command)), rootPID);
    const runtime = this.options.providerRuntime?.();
    const providerRoot = runtime?.process?.root_pid ?? 0;
    const providerPIDs = providerRoot > 0 ? new Set(descendantTree(tree, providerRoot).map((row) => row.pid)) : new Set<number>();
    const owner = safeOwner(runtime?.owners ?? []);
    return tree.map((row) => {
      const startedAt = processStartedAt(row);
      return {
        ...row,
        identity: `${row.pid}@${startedAt}`,
        owner: row.pid === rootPID ? "runner" : providerPIDs.has(row.pid) ? owner : genericOwner(row.command),
        role: row.pid === rootPID ? "runner" : processRole(row.command, providerPIDs.has(row.pid)),
        started_at: startedAt || now.toISOString()
      };
    });
  }

  private trackExited(rows: ObservedProcess[], now: Date): void {
    const current = new Map<string, ObservedProcess & { last_seen_at: string; peak_rss_bytes: number }>();
    for (const row of rows) {
      const previous = this.lastProcesses.get(row.identity);
      current.set(row.identity, {
        ...row,
        last_seen_at: now.toISOString(),
        peak_rss_bytes: Math.max(row.rss_bytes, previous?.peak_rss_bytes ?? 0)
      });
    }
    for (const previous of this.lastProcesses.values()) {
      if (current.has(previous.identity)) continue;
      this.recentExited.push({
        last_seen_at: previous.last_seen_at,
        owner: previous.owner,
        peak_rss_bytes: previous.peak_rss_bytes,
        pid: previous.pid,
        role: previous.role,
        started_at: previous.started_at
      });
    }
    if (this.recentExited.length > 100) this.recentExited.splice(0, this.recentExited.length - 100);
    this.lastProcesses = current;
  }

  private activity(now: Date): { active: boolean; public: Record<string, unknown>; workloadActive: boolean } {
    const issueRuns = Math.max(0, this.options.activeRuns?.() ?? 0);
    const agentic = this.options.agenticActivity?.() ?? { in_flight: 0, last_activity_at: "" };
    const inFlight = Math.max(0, Number.isFinite(agentic.in_flight) ? Math.trunc(agentic.in_flight) : 0);
    const lastActivityMs = Date.parse(agentic.last_activity_at);
    const graceMs = this.options.agenticIdleGraceMs ?? PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS;
    const ageMs = Number.isFinite(lastActivityMs) ? Math.max(0, now.getTime() - lastActivityMs) : null;
    const agenticInCooldown = inFlight === 0 && ageMs !== null && ageMs <= graceMs;
    const maintenanceLastActivityMs = Date.parse(this.maintenanceLastActivityAt);
    const maintenanceGraceMs = this.options.maintenanceIdleGraceMs
      ?? PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS;
    const maintenanceAgeMs = Number.isFinite(maintenanceLastActivityMs)
      ? Math.max(0, now.getTime() - maintenanceLastActivityMs)
      : null;
    const maintenanceInCooldown = this.maintenanceInFlight === 0
      && maintenanceAgeMs !== null
      && maintenanceAgeMs <= maintenanceGraceMs;
    const workloadActive = issueRuns > 0 || inFlight > 0 || agenticInCooldown;
    const directlyActive = issueRuns > 0 || inFlight > 0 || this.maintenanceInFlight > 0;
    const inCooldown = agenticInCooldown || maintenanceInCooldown;
    const active = directlyActive || inCooldown;
    return {
      active,
      workloadActive,
      public: {
        agentic_in_flight: inFlight,
        agentic_last_activity_at: agentic.last_activity_at,
        agentic_last_activity_age_ms: ageMs,
        idle_grace_ms: graceMs,
        issue_runs: issueRuns,
        maintenance_idle_grace_ms: maintenanceGraceMs,
        maintenance_in_flight: this.maintenanceInFlight,
        maintenance_last_activity_at: this.maintenanceLastActivityAt,
        maintenance_last_activity_age_ms: maintenanceAgeMs,
        status: directlyActive ? "active" : inCooldown ? "cooldown" : "idle"
      }
    };
  }

  private phase(rows: ObservedProcess[], active: boolean): ProcessMemoryPhase {
    if (active) return "run";
    return rows.some((row) => row.role === "usage-index") ? "usage" : "idle";
  }

  private reclaimIdleMemory(now: Date): void {
    if (!this.options.reclaimMemory) {
      this.reclaimStatus = "disabled";
      return;
    }
    const minIntervalMs = this.options.reclaimMinIntervalMs ?? PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS;
    if (this.lastReclaimedAt !== undefined && now.getTime() - this.lastReclaimedAt < minIntervalMs) {
      this.reclaimStatus = "throttled";
      return;
    }
    try {
      this.options.reclaimMemory();
      this.lastReclaimedAt = now.getTime();
      this.reclaimStatus = "completed";
      this.footprintProbe.invalidate();
    } catch (error) {
      this.reclaimStatus = "failed";
      console.error(JSON.stringify({
        event: "runner.process_group_memory_reclaim_failed",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error))
      }));
    }
  }

  private memoryReclaimSnapshot(now: Date): Record<string, unknown> {
    const minIntervalMs = this.options.reclaimMinIntervalMs ?? PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS;
    return {
      last_reclaimed_at: this.lastReclaimedAt === undefined ? "" : new Date(this.lastReclaimedAt).toISOString(),
      min_interval_ms: minIntervalMs,
      next_eligible_at: this.lastReclaimedAt === undefined
        ? now.toISOString()
        : new Date(this.lastReclaimedAt + minIntervalMs).toISOString(),
      status: this.options.reclaimMemory ? this.reclaimStatus : "disabled"
    };
  }

  private inspect(): ProcessTreeEntry[] { return (this.options.inspect ?? inspectMemoryProcessTable)(); }

  private memoryUsage(): ProcessMemoryUsage { return this.options.memoryUsage?.() ?? process.memoryUsage(); }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  private runnerPid(): number { return this.options.runnerPid ?? process.pid; }

  private sampleIntervalMs(): number { return this.options.sampleIntervalMs ?? PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS; }
}
