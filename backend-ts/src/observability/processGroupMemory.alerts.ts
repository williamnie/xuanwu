import { listPiGuardianAlerts, resolvePiGuardianAlert, updatePiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ProcessMemoryBudgetAlert, ProcessMemoryBudgetRecovery } from "./processGroupMemory.model.ts";
import { highestMemorySeverity, severityRank } from "./processGroupMemory.values.ts";

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

export const PROCESS_GROUP_MEMORY_ALERT_TYPE = "runner_process_group_memory_budget";

export const PROCESS_GROUP_MEMORY_ALERT_GROUP = "runner-memory";

export function upsertCanonicalProcessGroupMemoryAlert(
  database: RunnerDatabase,
  alert: ProcessMemoryBudgetAlert,
  event: Record<string, unknown>
): void {
  const all = listPiGuardianAlerts(database, {
    alertType: PROCESS_GROUP_MEMORY_ALERT_TYPE
  });
  const active = ["open", "acked"].flatMap((status) => listPiGuardianAlerts(database, {
    alertType: PROCESS_GROUP_MEMORY_ALERT_TYPE,
    status
  }));
  const canonical = active.find((item) => item.run_group_id === PROCESS_GROUP_MEMORY_ALERT_GROUP)
    ?? all.find((item) => item.run_group_id === PROCESS_GROUP_MEMORY_ALERT_GROUP);
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
