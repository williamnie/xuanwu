import type { RunnerDatabase } from "../db/database.ts";
import {
  claimDueAutomationRuns,
  completeAutomationRun,
  failAutomationRun,
  type ClaimedAutomationRun
} from "../db/repositories/automationScheduler.ts";
import { getAutomation, getAutomationTrigger } from "../db/repositories/automations.ts";
import type { AutomationDefinition, VersionedAutomationTrigger } from "../domain/automation/contracts.ts";

export type AutomationExecutionResult = { detail?: string } | void;
export type AutomationExecutor = (input: {
  automation: AutomationDefinition;
  run: ClaimedAutomationRun;
  trigger: VersionedAutomationTrigger;
  database: RunnerDatabase;
  now: Date;
}) => Promise<AutomationExecutionResult>;

export type AutomationSchedulerResult = {
  deadLettered: number;
  executed: number;
  failed: number;
  scanned: number;
  skipped: number;
};

export type AutomationSchedulerInput = {
  database: RunnerDatabase;
  executeAutomation?: AutomationExecutor;
  limit?: number;
  now?: Date;
};

// The loop only activates native Automation definitions when a governed executor is
// registered. Legacy scheduler carriers remain their own authorities through W0.
export async function runDueAutomations(input: AutomationSchedulerInput): Promise<AutomationSchedulerResult> {
  if (!input.executeAutomation) return { deadLettered: 0, executed: 0, failed: 0, scanned: 0, skipped: 0 };
  const now = input.now ?? new Date();
  const due = claimDueAutomationRuns(input.database, now, input.limit);
  const result: AutomationSchedulerResult = {
    deadLettered: due.dead_lettered,
    executed: 0,
    failed: 0,
    scanned: due.claimed.length,
    skipped: due.skipped_misfires
  };
  for (const run of due.claimed) {
    const automation = getAutomation(input.database, run.automation_id);
    const trigger = automation && getAutomationTrigger(input.database, run.automation_id, run.trigger_version);
    if (!automation || !trigger || automation.status !== "active") {
      failAutomationRun(input.database, run, now, new Error("automation definition or trigger is unavailable"));
      result.failed += 1;
      continue;
    }
    try {
      const output = await input.executeAutomation({ automation, database: input.database, now, run, trigger });
      if (completeAutomationRun(input.database, run, now, output?.detail)) result.executed += 1;
    } catch (error) {
      const outcome = failAutomationRun(input.database, run, now, error);
      if (outcome === "dead_lettered") result.deadLettered += 1;
      if (outcome !== "stale") result.failed += 1;
    }
  }
  return result;
}
