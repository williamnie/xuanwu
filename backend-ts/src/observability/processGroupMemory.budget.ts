
import { redactSensitiveText } from "../util/redact.ts";
import { PROCESS_GROUP_MEMORY_BUDGETS } from './processGroupMemory.model.ts';
import type { ProcessMemoryPhase, ObservedProcess, ProcessGroupMemoryOptions, FootprintMeasurementSource } from './processGroupMemory.model.ts';

import { publicProcesses } from './processGroupMemory.processes.ts';

export class MemoryBudgetTracker {
  idleBaselineBytes?: number;
  lastRunObservedAt?: number;
  private consecutiveHard = 0;
  private consecutiveSoft = 0;
  private activeAlert = '';
  private healthyNotified = false;
  constructor(private readonly options: ProcessGroupMemoryOptions,
    private readonly sampleIntervalMs: () => number, private readonly now: () => Date) {}

status(
    phase: ProcessMemoryPhase,
    measurement: { group_bytes: number; main_bytes: number; source: FootprintMeasurementSource },
    p95RSS: number,
    mainRSS: number,
    groupRSS: number,
    now: Date,
    footprintAttempted: boolean
  ): Record<string, unknown> {
    const group = phase === "run"
      ? PROCESS_GROUP_MEMORY_BUDGETS.active_run_group_rss_p95_bytes
      : PROCESS_GROUP_MEMORY_BUDGETS.idle_group_rss_p95_bytes;
    const main = PROCESS_GROUP_MEMORY_BUDGETS.idle_main_rss_bytes;
    const postRun = this.postRunStatus(phase, groupRSS, now);
    const measurementPending = this.options.footprint !== false && !footprintAttempted;
    const hardExceeded = !measurementPending && (measurement.group_bytes > group.hard
      || (phase !== "run" && measurement.main_bytes > main.hard)
      || postRun.hard_exceeded);
    const softExceeded = !measurementPending && (measurement.group_bytes > group.soft
      || (phase !== "run" && measurement.main_bytes > main.soft)
      || postRun.soft_exceeded);
    this.consecutiveHard = hardExceeded ? this.consecutiveHard + 1 : 0;
    this.consecutiveSoft = softExceeded ? this.consecutiveSoft + 1 : 0;
    const requiredHardSamples = Math.ceil(PROCESS_GROUP_MEMORY_BUDGETS.alert_after_ms.hard / this.sampleIntervalMs());
    const requiredSoftSamples = Math.ceil(PROCESS_GROUP_MEMORY_BUDGETS.alert_after_ms.soft / this.sampleIntervalMs());
    const alertingHard = this.consecutiveHard >= requiredHardSamples;
    const alertingSoft = this.consecutiveSoft >= requiredSoftSamples;
    return {
      auto_restart: false,
      alert_after_ms: PROCESS_GROUP_MEMORY_BUDGETS.alert_after_ms,
      consecutive_hard: this.consecutiveHard,
      consecutive_soft: this.consecutiveSoft,
      required_consecutive_hard: requiredHardSamples,
      required_consecutive_soft: requiredSoftSamples,
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

alert(phase: ProcessMemoryPhase, budget: Record<string, unknown>, rows: ObservedProcess[], sampleValue: Record<string, unknown>): void {
    const status = String(budget.status ?? "");
    const key = status === "hard_exceeded" ? `${phase}:hard` : status === "soft_exceeded" ? `${phase}:soft` : "";
    if (!key) {
      if (status === "within_budget" && (!this.healthyNotified || this.activeAlert !== "")) {
        try {
          this.options.onRecovery?.({
            budget,
            phase,
            sampled_at: String(sampleValue?.sampled_at ?? this.now().toISOString())
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
          sampled_at: sampleValue?.sampled_at,
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
}
