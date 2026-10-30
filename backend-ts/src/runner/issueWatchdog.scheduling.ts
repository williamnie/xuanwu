import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import { type ProjectLoopDecision } from "./projectLoop.ts";
import { startProjectLoop } from "./projectLoopManager.ts";
import { cleanString } from "../util/values.ts";
import { DEFAULT_MAX_KICK_ATTEMPTS } from "./issueWatchdog.model.ts";
import type { IssueWatchdogInput, StaleTodoRow, IssueWatchdogSummary, WatchdogState } from "./issueWatchdog.model.ts";
import { nextCheck, positiveInteger, hash } from "./issueWatchdog.values.ts";
import { latestWatchdogState, statePayload } from "./issueWatchdog.state.ts";
import { resolveChangedWatchdogAlerts, ensureWatchdogAttention } from "./issueWatchdog.alerts.ts";
import { recordWatchdogEvent, lastWatchdogKickAt, watchdogKickAttempts, publishNeedsUser } from "./issueWatchdog.events.ts";
import { providerRuntimeBlocker } from "./issueWatchdog.blockers.ts";

export function handleRunnable(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  summary: IssueWatchdogSummary,
  now: Date,
  escalateAfterMs: number
): void {
  const state = waitState(row, {
    attention: false,
    authority: "work_relations(kind=depends_on)+issues.status",
    nextCheckAt: nextCheck(now, escalateAfterMs),
    reason: "ready",
    rootBlocker: null
  });
  const previous = latestWatchdogState(input.database, row.id);
  if (previous.stateKey !== state.stateKey) {
    resolveChangedWatchdogAlerts(input.database, row, state.stateKey, now);
    recordWatchdogEvent(input.database, row.id, "issue.watchdog_kicked", statePayload(state, {
      reason: "todo_without_session"
    }), now);
    startProjectLoop({
      bus: input.bus,
      database: input.database,
      providers: input.providers
    }, row.project_id);
    summary.kicked += 1;
    return;
  }

  const lastKick = lastWatchdogKickAt(input.database, row.id);
  if (lastKick && now.getTime() - Date.parse(lastKick) < escalateAfterMs) {
    summary.recentlyKicked += 1;
    return;
  }

  const kickAttempts = watchdogKickAttempts(input.database, row.id, state.stateKey);
  if (kickAttempts < positiveInteger(input.maxKickAttempts, DEFAULT_MAX_KICK_ATTEMPTS)) {
    recordWatchdogEvent(input.database, row.id, "issue.watchdog_kicked", statePayload(state, {
      attempt: kickAttempts + 1,
      reason: "todo_without_session"
    }), now);
    startProjectLoop({
      bus: input.bus,
      database: input.database,
      providers: input.providers
    }, row.project_id);
    summary.kicked += 1;
    return;
  }

  const stuck = { ...state, attention: true, reason: "runnable_without_runtime" };
  if (ensureWatchdogAttention(input.database, row, stuck, now)) summary.attentioned += 1;
  if (publishNeedsUser(input, row, now, "todo_without_session", stuck.stateKey)) {
    recordWatchdogEvent(input.database, row.id, "issue.watchdog_needs_user", statePayload(stuck, {
      diagnosis: "todo_without_session"
    }), now);
    summary.escalated += 1;
  }
}

export function handleWaiting(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  summary: IssueWatchdogSummary,
  now: Date,
  state: WatchdogState
): void {
  const previous = latestWatchdogState(input.database, row.id);
  if (previous.stateKey !== state.stateKey) {
    resolveChangedWatchdogAlerts(input.database, row, "", now);
    recordWatchdogEvent(input.database, row.id, "issue.watchdog_waiting", statePayload(state), now);
  }
  if (state.attention && ensureWatchdogAttention(input.database, row, state, now)) summary.attentioned += 1;
  summary.waiting += 1;
}

export function stateFromDecision(
  db: RunnerDatabase,
  row: StaleTodoRow,
  decision: ProjectLoopDecision,
  now: Date,
  staleAfterMs: number
): WatchdogState {
  if (decision.reason === "dependency_blocker") {
    const dependency = readIssueDependency(db, row.id);
    const reason = dependency?.reason ?? decision.reason;
    return waitState(row, {
      attention: ["dependency_cycle", "failed_dependency", "missing_dependency"].includes(reason),
      authority: decision.authority,
      nextCheckAt: nextCheck(now, staleAfterMs),
      reason,
      rootBlocker: dependency?.root_blockers ?? []
    });
  }
  if (decision.reason === "project_hold") {
    const hold = getProject(db, row.project_id)?.hold;
    return waitState(row, {
      attention: false,
      authority: decision.authority,
      nextCheckAt: hold?.next_check_at || nextCheck(now, staleAfterMs),
      reason: "project_hold",
      rootBlocker: hold ? {
        message: hold.message,
        project_id: row.project_id,
        reason: hold.reason
      } : { project_id: row.project_id }
    });
  }
  if (decision.reason === "provider_runtime") {
    const blocker = providerRuntimeBlocker(db, decision.provider);
    return waitState(row, {
      attention: true,
      authority: decision.authority,
      nextCheckAt: cleanString(blocker.next_check_at) || nextCheck(now, staleAfterMs),
      reason: blocker.issue_id ? "provider_backoff" : "provider_unavailable",
      rootBlocker: blocker
    });
  }
  return waitState(row, {
    attention: false,
    authority: decision.authority,
    nextCheckAt: nextCheck(now, staleAfterMs),
    reason: decision.reason,
    rootBlocker: { scope: decision.scope }
  });
}

export function waitState(
  row: StaleTodoRow,
  input: Omit<WatchdogState, "stateKey">
): WatchdogState {
  const identity = JSON.stringify({
    authority: input.authority,
    issue_id: row.id,
    issue_updated_at: row.updated_at,
    provider: row.provider,
    reason: input.reason,
    root_blocker: input.rootBlocker
  });
  return { ...input, stateKey: `issue-watchdog:${row.id}:${hash(identity)}` };
}
