import {
  listPiGuardianAlerts,
  resolvePiGuardianAlert,
  updatePiGuardianAlert,
  upsertPiGuardianAlert
} from "../db/repositories/pi/guardianAlerts.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { CodexProcessOwnership, ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import type { AgenticActivitySnapshot } from "../agentic/protocol.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { collectDarwinPhysicalFootprints } from "./darwinProcessMemory.ts";

export const PROCESS_GROUP_MEMORY_CONTRACT = "runner-process-group-memory.v1" as const;
export const PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS = 1_000;
export const PROCESS_GROUP_MEMORY_FRESHNESS_MS = 5_000;
export const PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS = 90_000;
export const PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS = 5_000;
export const PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS = {
  footprint_bytes: "macOS footprint (phys_footprint) from non-suspending proc_pid_rusage, summed per observed PID",
  process_rss_bytes: "process.memoryUsage().rss for the runner main process only",
  ps_rss_bytes: "resident set reported by macOS ps for each runner descendant; process-group values are summed",
  probes_excluded: ["ps", "/usr/bin/footprint"]
} as const;
export const PROCESS_GROUP_MEMORY_BUDGETS = {
  consecutive: { hard: 3, soft: 6 },
  idle_main_rss_bytes: { hard: 256 * 1024 * 1024, soft: 224 * 1024 * 1024 },
  idle_group_rss_p95_bytes: { hard: 320 * 1024 * 1024, soft: 288 * 1024 * 1024 },
  active_run_group_rss_p95_bytes: { hard: 700 * 1024 * 1024, soft: 640 * 1024 * 1024 },
  post_run_delta_bytes: { hard: 32 * 1024 * 1024, soft: 24 * 1024 * 1024 },
  soak_drift_bytes: { hard: 64 * 1024 * 1024, soft: 48 * 1024 * 1024 }
} as const;

export type ProcessMemoryPhase = "idle" | "run" | "usage";
export type ProcessMemoryBudgetLevel = "hard" | "soft";
export type ProcessMemoryBudgetAlert = {
  budget: Record<string, unknown>;
  level: ProcessMemoryBudgetLevel;
  phase: ProcessMemoryPhase;
  sample: Record<string, unknown>;
};
export type ProcessMemoryBudgetRecovery = {
  budget: Record<string, unknown>;
  phase: ProcessMemoryPhase;
  sampled_at: string;
};

type RuntimeOwnership = { idle_ttl_ms?: number; owners: string[]; process?: CodexProcessOwnership } | undefined;
type ProcessMemoryUsage = ReturnType<typeof process.memoryUsage>;
type ProcessGroupMemoryOptions = {
  activeRuns?: () => number;
  agenticActivity?: () => AgenticActivitySnapshot;
  agenticIdleGraceMs?: number;
  footprint?: false | ((pids: number[]) => Promise<Map<number, number>>);
  footprintIntervalMs?: number;
  inspect?: () => ProcessTreeEntry[];
  maintenanceIdleGraceMs?: number;
  memoryUsage?: () => ProcessMemoryUsage;
  now?: () => Date;
  onAlert?: (alert: ProcessMemoryBudgetAlert) => void;
  onRecovery?: (recovery: ProcessMemoryBudgetRecovery) => void;
  providerRuntime?: () => RuntimeOwnership;
  reclaimMemory?: () => void;
  runnerPid?: number;
  sampleIntervalMs?: number;
};

type ObservedProcess = ProcessTreeEntry & {
  identity: string;
  owner: string;
  role: string;
  started_at: string;
};
type FootprintMeasurementSource = "footprint" | "footprint+rss" | "rss";
type FootprintState = {
  bytes: number;
  by_identity: Map<string, number>;
  main_bytes: number;
  observed_at: string;
  process_count: number;
};

export class ProcessGroupMemoryObserver {
  private activeAlert = "";
  private consecutiveHard = 0;
  private consecutiveSoft = 0;
  private footprint?: FootprintState;
  private footprintAttempted = false;
  private footprintGeneration = 0;
  private footprintInFlight = false;
  private history: Array<{ phase: ProcessMemoryPhase; rss_bytes: number; sampled_at: string }> = [];
  private healthyNotified = false;
  private idleReclaimPending = false;
  private idleBaselineBytes?: number;
  private lastRunObservedAt?: number;
  private maintenanceInFlight = 0;
  private maintenanceLastActivityAt = "";
  private lastProcesses = new Map<string, ObservedProcess & { last_seen_at: string; peak_rss_bytes: number }>();
  private recentExited: Array<Record<string, unknown>> = [];
  private sampleValue?: Record<string, unknown>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: ProcessGroupMemoryOptions = {}) {}

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
      this.reclaimIdleMemory();
      this.idleReclaimPending = false;
    }
    const memory = this.memoryUsage();
    const groupRSS = rows.reduce((total, row) => total + row.rss_bytes, 0);
    if (phase === "run") this.lastRunObservedAt = now.getTime();
    this.history.push({ phase, rss_bytes: groupRSS, sampled_at: now.toISOString() });
    if (this.history.length > 1_800) this.history.splice(0, this.history.length - 1_800);
    this.trackExited(rows, now);
    const phaseRSS = this.history.filter((item) => item.phase === phase).map((item) => item.rss_bytes);
    const p95RSS = percentile(phaseRSS, 0.95);
    if (phase === "idle" && this.lastRunObservedAt === undefined) {
      this.idleBaselineBytes = percentile(phaseRSS.slice(-60), 0.5);
    }
    const main = rows.find((row) => row.pid === this.runnerPid());
    const budgetMeasurement = this.budgetMeasurement(rows, p95RSS, main?.rss_bytes ?? memory.rss, now);
    const budget = this.budgetStatus(phase, budgetMeasurement, p95RSS, main?.rss_bytes ?? memory.rss, groupRSS, now);
    const roles = roleSummaries(rows);
    const sampledAt = now.toISOString();
    this.sampleValue = {
      contract: PROCESS_GROUP_MEMORY_CONTRACT,
      sampled_at: sampledAt,
      freshness: { age_ms: 0, stale_after_ms: PROCESS_GROUP_MEMORY_FRESHNESS_MS, status: "fresh" },
      phase,
      activity: activity.public,
      aggregate: {
        footprint_bytes: positiveBytes(this.footprint?.bytes),
        footprint_main_bytes: positiveBytes(this.footprint?.main_bytes),
        footprint_observed_at: this.footprint?.observed_at ?? "",
        footprint_process_count: this.footprint?.process_count ?? 0,
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
        physical_memory_probe: this.options.footprint === false ? "disabled" : this.footprintAttempted ? "ready" : "pending",
        source: budget.measurement_source
      },
      metric_definitions: PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS
    };
    this.maybeAlert(phase, budget, rows);
    this.maybeRefreshFootprint(rows, now);
    return this.snapshot();
  }

  snapshot(): Record<string, unknown> {
    if (!this.sampleValue) return this.sample();
    const sampledAt = Date.parse(String(this.sampleValue.sampled_at ?? ""));
    const age = Number.isFinite(sampledAt) ? Math.max(0, this.now().getTime() - sampledAt) : Number.MAX_SAFE_INTEGER;
    return {
      ...structuredClone(this.sampleValue),
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

  private activity(now: Date): { active: boolean; public: Record<string, unknown> } {
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
    const directlyActive = issueRuns > 0 || inFlight > 0 || this.maintenanceInFlight > 0;
    const inCooldown = agenticInCooldown || maintenanceInCooldown;
    const active = directlyActive || inCooldown;
    return {
      active,
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

  private reclaimIdleMemory(): void {
    try {
      this.options.reclaimMemory?.();
      if (this.options.reclaimMemory) {
        this.footprintGeneration += 1;
        this.footprint = undefined;
        this.footprintAttempted = false;
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "runner.process_group_memory_reclaim_failed",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error))
      }));
    }
  }

  private budgetStatus(
    phase: ProcessMemoryPhase,
    measurement: { group_bytes: number; main_bytes: number; source: FootprintMeasurementSource },
    p95RSS: number,
    mainRSS: number,
    groupRSS: number,
    now: Date
  ): Record<string, unknown> {
    const group = phase === "run"
      ? PROCESS_GROUP_MEMORY_BUDGETS.active_run_group_rss_p95_bytes
      : PROCESS_GROUP_MEMORY_BUDGETS.idle_group_rss_p95_bytes;
    const main = PROCESS_GROUP_MEMORY_BUDGETS.idle_main_rss_bytes;
    const postRun = this.postRunStatus(phase, groupRSS, now);
    const measurementPending = this.options.footprint !== false && !this.footprintAttempted;
    const hardExceeded = !measurementPending && (measurement.group_bytes > group.hard
      || (phase !== "run" && measurement.main_bytes > main.hard)
      || postRun.hard_exceeded);
    const softExceeded = !measurementPending && (measurement.group_bytes > group.soft
      || (phase !== "run" && measurement.main_bytes > main.soft)
      || postRun.soft_exceeded);
    this.consecutiveHard = hardExceeded ? this.consecutiveHard + 1 : 0;
    this.consecutiveSoft = softExceeded ? this.consecutiveSoft + 1 : 0;
    const alertingHard = this.consecutiveHard >= PROCESS_GROUP_MEMORY_BUDGETS.consecutive.hard;
    const alertingSoft = this.consecutiveSoft >= PROCESS_GROUP_MEMORY_BUDGETS.consecutive.soft;
    return {
      auto_restart: false,
      consecutive_hard: this.consecutiveHard,
      consecutive_soft: this.consecutiveSoft,
      group_rss_p95_bytes: p95RSS,
      hard_bytes: group.hard,
      main_hard_bytes: phase === "run" ? null : main.hard,
      main_rss_bytes: mainRSS,
      main_soft_bytes: phase === "run" ? null : main.soft,
      measured_group_bytes: measurement.group_bytes,
      measured_main_bytes: measurement.main_bytes,
      measurement_source: measurement.source,
      measurement_ready: !measurementPending,
      post_run: postRun.public,
      soft_bytes: group.soft,
      status: measurementPending ? "measurement_pending" : alertingHard ? "hard_exceeded" : alertingSoft ? "soft_exceeded" : hardExceeded ? "hard_pending" : softExceeded ? "soft_pending" : "within_budget"
    };
  }

  private budgetMeasurement(
    rows: ObservedProcess[],
    p95RSS: number,
    mainRSS: number,
    now: Date
  ): { group_bytes: number; main_bytes: number; source: FootprintMeasurementSource } {
    const footprint = this.footprint;
    const observedAt = Date.parse(footprint?.observed_at ?? "");
    const footprintInterval = this.options.footprintIntervalMs ?? 60_000;
    const maxAge = Math.max(PROCESS_GROUP_MEMORY_FRESHNESS_MS, footprintInterval * 2);
    if (footprint && footprint.bytes > 0 && footprint.main_bytes > 0
      && footprint.by_identity.size > 0
      && Number.isFinite(observedAt) && now.getTime() - observedAt <= maxAge) {
      let covered = 0;
      let groupBytes = 0;
      let measuredMain = mainRSS;
      for (const row of rows) {
        const physical = footprint.by_identity.get(row.identity);
        if (physical === undefined) {
          groupBytes += row.rss_bytes;
          continue;
        }
        covered += 1;
        groupBytes += physical;
        if (row.pid === this.runnerPid()) measuredMain = physical;
      }
      if (covered > 0) return {
        group_bytes: groupBytes,
        main_bytes: measuredMain,
        source: covered === rows.length ? "footprint" : "footprint+rss"
      };
    }
    return { group_bytes: p95RSS, main_bytes: mainRSS, source: "rss" };
  }

  private postRunStatus(phase: ProcessMemoryPhase, groupRSS: number, now: Date): {
    hard_exceeded: boolean;
    public: Record<string, unknown>;
    soft_exceeded: boolean;
  } {
    const baseline = this.idleBaselineBytes;
    const lastRun = this.lastRunObservedAt;
    const ttl = this.options.providerRuntime?.()?.idle_ttl_ms ?? 15_000;
    if (phase === "run" || baseline === undefined || lastRun === undefined) {
      return { hard_exceeded: false, soft_exceeded: false, public: {
        baseline_rss_bytes: baseline ?? null,
        status: phase === "run" ? "run_active" : baseline === undefined ? "baseline_unavailable" : "not_pending",
        ttl_ms: ttl
      } };
    }
    const dueAt = lastRun + ttl;
    const delta = Math.max(0, groupRSS - baseline);
    if (now.getTime() < dueAt) return { hard_exceeded: false, soft_exceeded: false, public: {
      baseline_rss_bytes: baseline, delta_bytes: delta, due_at: new Date(dueAt).toISOString(), status: "ttl_pending", ttl_ms: ttl
    } };
    const hard = delta > PROCESS_GROUP_MEMORY_BUDGETS.post_run_delta_bytes.hard;
    const soft = delta > PROCESS_GROUP_MEMORY_BUDGETS.post_run_delta_bytes.soft;
    if (!soft) this.lastRunObservedAt = undefined;
    return { hard_exceeded: hard, soft_exceeded: soft, public: {
      baseline_rss_bytes: baseline, delta_bytes: delta, due_at: new Date(dueAt).toISOString(), status: hard ? "hard_exceeded" : soft ? "soft_exceeded" : "recovered", ttl_ms: ttl
    } };
  }

  private maybeAlert(phase: ProcessMemoryPhase, budget: Record<string, unknown>, rows: ObservedProcess[]): void {
    const status = String(budget.status ?? "");
    const key = status === "hard_exceeded" ? `${phase}:hard` : status === "soft_exceeded" ? `${phase}:soft` : "";
    if (!key) {
      if (status === "within_budget" && (!this.healthyNotified || this.activeAlert !== "")) {
        try {
          this.options.onRecovery?.({
            budget,
            phase,
            sampled_at: String(this.sampleValue?.sampled_at ?? this.now().toISOString())
          });
        } catch (error) {
          console.error(JSON.stringify({
            event: "runner.process_group_memory_recovery_write_failed",
            error: redactSensitiveText(error instanceof Error ? error.message : String(error))
          }));
        }
        this.healthyNotified = true;
      }
      this.activeAlert = "";
      return;
    }
    if (this.activeAlert === key) return;
    this.activeAlert = key;
    this.healthyNotified = false;
    const level = key.endsWith(":hard") ? "hard" : "soft";
    try {
      this.options.onAlert?.({
        budget,
        level,
        phase,
        sample: {
          sampled_at: this.sampleValue?.sampled_at,
          top_by_rss: publicProcesses([...rows].sort((left, right) => right.rss_bytes - left.rss_bytes).slice(0, 5))
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "runner.process_group_memory_alert_write_failed",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error))
      }));
    }
  }

  private maybeRefreshFootprint(rows: ObservedProcess[], now: Date): void {
    if (this.options.footprint === false) return;
    if (this.footprintInFlight) return;
    const previous = Date.parse(this.footprint?.observed_at ?? "");
    const currentIdentities = new Set(rows.map((row) => row.identity));
    const measuredIdentities = new Set(this.footprint?.by_identity.keys() ?? []);
    const membershipChanged = currentIdentities.size !== measuredIdentities.size
      || [...currentIdentities].some((identity) => !measuredIdentities.has(identity));
    if (!membershipChanged && Number.isFinite(previous)
      && now.getTime() - previous < (this.options.footprintIntervalMs ?? 60_000)) return;
    const expected = new Map(rows.map((row) => [row.pid, row.identity]));
    const generation = this.footprintGeneration;
    this.footprintInFlight = true;
    void (this.options.footprint ?? collectMacOSFootprint)([...expected.keys()]).then((values) => {
      if (generation !== this.footprintGeneration) return;
      const live = new Map(this.observedTree(this.inspect(), this.now()).map((row) => [row.pid, row.identity]));
      const valid = [...values].filter(([pid]) => live.get(pid) === expected.get(pid));
      const validValues = new Map(valid);
      this.footprint = {
        bytes: valid.reduce((total, [, bytes]) => total + bytes, 0),
        by_identity: new Map(valid.map(([pid, bytes]) => [expected.get(pid)!, bytes])),
        main_bytes: validValues.get(this.runnerPid()) ?? 0,
        observed_at: this.now().toISOString(),
        process_count: valid.length
      };
    }).catch(() => {}).finally(() => {
      if (generation === this.footprintGeneration) this.footprintAttempted = true;
      this.footprintInFlight = false;
    });
  }

  private inspect(): ProcessTreeEntry[] { return (this.options.inspect ?? inspectMemoryProcessTable)(); }
  private memoryUsage(): ProcessMemoryUsage { return this.options.memoryUsage?.() ?? process.memoryUsage(); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private runnerPid(): number { return this.options.runnerPid ?? process.pid; }
  private sampleIntervalMs(): number { return this.options.sampleIntervalMs ?? PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS; }
}

export function writeProcessGroupMemoryAlert(database: RunnerDatabase, alert: ProcessMemoryBudgetAlert): void {
  const event = {
    event: "runner.process_group_memory_budget_exceeded",
    level: alert.level,
    phase: alert.phase,
    budget: alert.budget,
    sample: alert.sample
  };
  console.warn(JSON.stringify(event));
  upsertCanonicalProcessGroupMemoryAlert(database, alert, event);
}

const PROCESS_GROUP_MEMORY_ALERT_TYPE = "runner_process_group_memory_budget";
const PROCESS_GROUP_MEMORY_ALERT_GROUP = "runner-memory";

function upsertCanonicalProcessGroupMemoryAlert(
  database: RunnerDatabase,
  alert: ProcessMemoryBudgetAlert,
  event: Record<string, unknown>
): void {
  const active = ["open", "acked"].flatMap((status) => listPiGuardianAlerts(database, {
    alertType: PROCESS_GROUP_MEMORY_ALERT_TYPE,
    status
  }));
  const canonical = active.find((item) => item.run_group_id === PROCESS_GROUP_MEMORY_ALERT_GROUP);
  const peakSeverity = highestMemorySeverity([
    ...active.map((item) => item.severity),
    alert.level === "hard" ? "urgent" : "high"
  ]);
  const previousPeak = highestMemorySeverity(active.map((item) => item.severity));
  const previousPeakAcked = active.some((item) => item.status === "acked" && severityRank(item.severity) === severityRank(previousPeak));
  const status = previousPeakAcked && severityRank(peakSeverity) <= severityRank(previousPeak) ? "acked" : "open";
  const evidence = { ...event, incident_peak_level: peakSeverity === "urgent" ? "hard" : "soft" };
  for (const legacy of active.filter((item) => item.id !== canonical?.id)) {
    resolvePiGuardianAlert(database, legacy.id, {
      evidence_json: {
        event: "runner.process_group_memory_alert_consolidated",
        canonical_run_group_id: PROCESS_GROUP_MEMORY_ALERT_GROUP
      },
      message: "Runner process-group memory alert consolidated into the canonical incident"
    });
  }
  if (canonical) {
    updatePiGuardianAlert(database, canonical.id, {
      evidence_json: evidence,
      message: "Runner process-group memory budget exceeded",
      severity: peakSeverity,
      status,
      watchdog_seen_at: String(alert.sample.sampled_at ?? new Date().toISOString())
    });
    return;
  }
  upsertPiGuardianAlert(database, {
    alert_type: PROCESS_GROUP_MEMORY_ALERT_TYPE,
    evidence_json: evidence,
    message: "Runner process-group memory budget exceeded",
    run_group_id: PROCESS_GROUP_MEMORY_ALERT_GROUP,
    severity: peakSeverity,
    status
  });
}

export function resolveRecoveredProcessGroupMemoryAlerts(
  database: RunnerDatabase,
  recovery: ProcessMemoryBudgetRecovery
): number {
  let resolved = 0;
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(database, {
      alertType: "runner_process_group_memory_budget",
      status
    })) {
      resolvePiGuardianAlert(database, alert.id, {
        evidence_json: {
          event: "runner.process_group_memory_budget_recovered",
          phase: recovery.phase,
          sampled_at: recovery.sampled_at,
          status: recovery.budget.status
        },
        message: "Runner process-group memory recovered within budget",
        watchdog_seen_at: recovery.sampled_at
      });
      resolved += 1;
    }
  }
  return resolved;
}

export function inspectMemoryProcessTable(): ProcessTreeEntry[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,rss=,lstart=,command="], { stderr: "ignore", stdout: "pipe" });
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).split("\n").map(parseMemoryProcessRow).filter(isProcessRow);
}

export async function collectMacOSFootprint(pids: number[]): Promise<Map<number, number>> {
  return await collectDarwinPhysicalFootprints(pids);
}

function parseMemoryProcessRow(line: string): ProcessTreeEntry | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return;
  return {
    command: `${match[5]}\t${match[6]}`,
    pgid: Number(match[3]), pid: Number(match[1]), ppid: Number(match[2]), rss_bytes: Number(match[4]) * 1024
  };
}

function processStartedAt(row: ProcessTreeEntry): string {
  if (!row.command.includes("\t")) return "unknown";
  const [value] = row.command.split("\t", 1);
  return value?.trim() && value !== "unknown" ? value : "unknown";
}

function rawCommand(command: string): string { return command.includes("\t") ? command.slice(command.indexOf("\t") + 1) : command; }
function descendantTree(rows: ProcessTreeEntry[], rootPID: number): ProcessTreeEntry[] {
  const root = rows.find((row) => row.pid === rootPID);
  if (!root) return [];
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
  return [...selected.values()];
}

function processRole(command: string, providerOwned: boolean): string {
  const value = rawCommand(command).toLowerCase();
  if (value.includes("codex-issue-runner-agentic")) return "agentic-worker";
  if (value.includes("__usage-index-worker")) return "usage-index";
  if (value.includes("app-server")) return "codex-app-server";
  if (value.includes("code-mode-host")) return "tool-host";
  if (value.includes("mcp") || value.includes("plugin-appserver")) return "mcp";
  return providerOwned ? "provider-child" : "runner-child";
}

function genericOwner(command: string): string {
  const value = rawCommand(command);
  if (value.includes("codex-issue-runner-agentic")) return "runner:agentic";
  return value.includes("__usage-index-worker") ? "runner:usage-index" : "runner:child";
}

function safeOwner(owners: string[]): string {
  if (owners.length === 0) return "provider:idle-ttl";
  if (owners.length > 1) return `provider:multiple:${owners.length}`;
  return redactSensitiveText(owners[0] ?? "provider").replace(/[^A-Za-z0-9:._~-]/g, "?").slice(0, 160);
}

function roleSummaries(rows: ObservedProcess[]): Array<Record<string, unknown>> {
  const roles = new Map<string, ObservedProcess[]>();
  for (const row of rows) roles.set(row.role, [...(roles.get(row.role) ?? []), row]);
  return [...roles].map(([role, items]) => ({
    process_count: items.length,
    role,
    rss_bytes: items.reduce((total, item) => total + item.rss_bytes, 0),
    top: publicProcesses([...items].sort((left, right) => right.rss_bytes - left.rss_bytes).slice(0, 3))
  })).sort((left, right) => Number(right.rss_bytes) - Number(left.rss_bytes));
}

function publicProcesses(rows: ObservedProcess[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    owner: row.owner, pid: row.pid, ppid: row.ppid, role: row.role, rss_bytes: row.rss_bytes, started_at: row.started_at
  }));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function isMemoryProbe(command: string): boolean {
  const value = rawCommand(command);
  return value.includes("ps -axo pid=,ppid=,pgid=,rss=,lstart=,command=") || value.includes("/usr/bin/footprint -f bytes --noCategories");
}
function isProcessRow(value: ProcessTreeEntry | undefined): value is ProcessTreeEntry { return value !== undefined; }

function positiveBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function highestMemorySeverity(values: string[]): string {
  return values.reduce((highest, value) => severityRank(value) > severityRank(highest) ? value : highest, "high");
}

function severityRank(value: string): number {
  return value === "urgent" ? 2 : value === "high" ? 1 : 0;
}
