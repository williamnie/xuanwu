import { countActiveExecutorWorkAt, hasActiveExecutorWorkForProject } from "../db/repositories/issueQueue.ts";
import { projectLoopDecision } from "./projectLoop.ts";
import { projectLoopMaxParallelProjects } from "./projectLoopManager.ts";
import { executionLocationMaximum, projectExecutionLocation } from "../nodes/capacity.ts";
import { DEFAULT_STALE_AFTER_MS, DEFAULT_ESCALATE_AFTER_MS, DEFAULT_LIMIT } from "./issueWatchdog.model.ts";
import type { IssueWatchdogInput, IssueWatchdogSummary } from "./issueWatchdog.model.ts";
import { optionalDate, positiveInteger, cutoffISO, nextCheck } from "./issueWatchdog.values.ts";
import { uniqueProjectRows, listStaleTodoWithoutRuntime, rowFromDecision } from "./issueWatchdog.queries.ts";
import { resolveInactiveWatchdogAlerts, resolveInactiveRuntimeMismatchAlerts } from "./issueWatchdog.alerts.ts";
import { handleTerminalSessionMismatches } from "./issueWatchdog.terminal.ts";
import { activeCapacityBlockers, activeProjectBlockers } from "./issueWatchdog.blockers.ts";
import { handleWaiting, waitState, stateFromDecision, handleRunnable } from "./issueWatchdog.scheduling.ts";

export async function runAutoRunIssueWatchdogOnce(input: IssueWatchdogInput): Promise<IssueWatchdogSummary> {
  const now = optionalDate(input.now) ?? new Date();
  const staleAfterMs = positiveInteger(input.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const escalateAfterMs = positiveInteger(input.escalateAfterMs, DEFAULT_ESCALATE_AFTER_MS);
  const cutoff = cutoffISO(now, staleAfterMs);
  const rows = uniqueProjectRows(listStaleTodoWithoutRuntime(
    input.database,
    cutoff,
    now.toISOString(),
    positiveInteger(input.limit, DEFAULT_LIMIT)
  ));
  resolveInactiveWatchdogAlerts(input.database, cutoff, now);
  resolveInactiveRuntimeMismatchAlerts(input.database, now);
  const summary: IssueWatchdogSummary = {
    attentioned: 0,
    candidates: rows.length,
    escalated: 0,
    kicked: 0,
    recentlyKicked: 0,
    scanned: rows.length,
    skippedBusy: 0,
    waiting: 0
  };
  handleTerminalSessionMismatches(input, summary, now, cutoff);
  if (rows.length === 0) return summary;

  // 名额按执行位置计算：中心本机满载不影响远程节点上的项目，反之亦然。
  const fullLocations = new Map<string, boolean>();
  const locationFull = (projectID: string) => {
    const location = projectExecutionLocation(input.database, projectID);
    if (!fullLocations.has(location)) {
      fullLocations.set(location, countActiveExecutorWorkAt(input.database, location) >=
        executionLocationMaximum(input.database, location, projectLoopMaxParallelProjects()));
    }
    return fullLocations.get(location)!;
  };
  let capacityBlocker: ReturnType<typeof activeCapacityBlockers> | undefined;

  for (const candidate of rows) {
    if (locationFull(candidate.project_id)) {
      capacityBlocker ??= activeCapacityBlockers(input.database);
      handleWaiting(input, candidate, summary, now, waitState(candidate, {
        attention: false,
        authority: "issues.status+issue_runs",
        nextCheckAt: nextCheck(now, escalateAfterMs),
        reason: "capacity_wait",
        rootBlocker: capacityBlocker
      }));
      summary.skippedBusy += 1;
      continue;
    }
    if (hasActiveExecutorWorkForProject(input.database, candidate.project_id, now)) {
      handleWaiting(input, candidate, summary, now, waitState(candidate, {
        attention: false,
        authority: "issues.status+issue_runs+project_execution_lock",
        nextCheckAt: nextCheck(now, escalateAfterMs),
        reason: "project_serial_wait",
        rootBlocker: activeProjectBlockers(input.database, candidate.project_id)
      }));
      summary.skippedBusy += 1;
      continue;
    }
    const decision = projectLoopDecision({
      bus: input.bus,
      database: input.database,
      now,
      projectId: candidate.project_id,
      providers: input.providers ?? {}
    }, false);
    const row = decision.issue ? rowFromDecision(candidate, decision) : candidate;
    if (!decision.allowed) {
      handleWaiting(input, row, summary, now, stateFromDecision(input.database, row, decision, now, staleAfterMs));
      continue;
    }
    handleRunnable(input, row, summary, now, escalateAfterMs);
    if (summary.kicked > 0) break;
  }
  return summary;
}
