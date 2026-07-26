import type { RunnerDatabase } from "../db/database.ts";
import {
  countActiveExecutorWork,
  hasActiveExecutorWorkForProject
} from "../db/repositories/issueQueue.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  listPiGuardianAlerts,
  resolvePiGuardianAlert,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import {
  projectLoopDecision,
  type ProjectLoopDecision
} from "./projectLoop.ts";
import {
  projectLoopMaxParallelProjects,
  startProjectLoop
} from "./projectLoopManager.ts";

export type IssueWatchdogSummary = {
  attentioned: number;
  candidates: number;
  escalated: number;
  kicked: number;
  recentlyKicked: number;
  scanned: number;
  skippedBusy: number;
  waiting: number;
};

export type IssueWatchdogInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  escalateAfterMs?: number;
  limit?: number;
  maxKickAttempts?: number;
  now?: Date | string;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  staleAfterMs?: number;
};

type StaleTodoRow = {
  created_at: string;
  id: number;
  project_id: string;
  project_name: string;
  provider: string;
  status: string;
  title: string;
  updated_at: string;
};

type WatchdogState = {
  attention: boolean;
  authority: string;
  nextCheckAt: string;
  reason: string;
  rootBlocker: unknown;
  stateKey: string;
};

type StoredWatchdogState = { stateKey: string };

const DEFAULT_ESCALATE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_KICK_ATTEMPTS = 3;
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const WATCHDOG_ALERT_PREFIX = "issue_watchdog_";

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
  if (rows.length === 0) return summary;

  const activeWork = countActiveExecutorWork(input.database);
  if (activeWork >= projectLoopMaxParallelProjects()) {
    const rootBlocker = activeCapacityBlockers(input.database);
    for (const row of rows) {
      handleWaiting(input, row, summary, now, waitState(row, {
        attention: false,
        authority: "issues.status+issue_runs",
        nextCheckAt: nextCheck(now, escalateAfterMs),
        reason: "capacity_wait",
        rootBlocker
      }));
    }
    summary.skippedBusy = rows.length;
    return summary;
  }

  for (const candidate of rows) {
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

function handleRunnable(
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

function handleWaiting(
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

function stateFromDecision(
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

function waitState(
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

function ensureWatchdogAttention(
  db: RunnerDatabase,
  row: StaleTodoRow,
  state: WatchdogState,
  now: Date
): boolean {
  const alertType = `${WATCHDOG_ALERT_PREFIX}${state.reason}`;
  const groupKey = attentionGroupKey(db, row.id, state.stateKey);
  const existing = listPiGuardianAlerts(db, { projectId: row.project_id, status: "open" })
    .some((alert) => alert.issue_id === row.id && alert.alert_type === alertType && alert.run_group_id === groupKey);
  if (existing) return false;
  upsertPiGuardianAlert(db, {
    alert_type: alertType,
    evidence_json: [`issue:${row.id}`, `watchdog_state:${state.stateKey}`],
    issue_id: row.id,
    message: watchdogAttentionMessage(row, state),
    project_id: row.project_id,
    run_group_id: groupKey,
    severity: "medium",
    watchdog_seen_at: now.toISOString()
  });
  return true;
}

function attentionGroupKey(db: RunnerDatabase, issueID: number, stateKey: string): string {
  const row = db.sqlite.query<{ id: number }, [number, string]>(`
    select id from issue_events
    where issue_id=? and type in ('issue.watchdog_kicked', 'issue.watchdog_waiting')
      and json_valid(payload) and json_extract(payload, '$.state_key')=?
    order by id desc limit 1
  `).get(issueID, stateKey);
  return `${stateKey}:event:${row?.id ?? 0}`;
}

function resolveChangedWatchdogAlerts(
  db: RunnerDatabase,
  row: StaleTodoRow,
  activeStateKey: string,
  now: Date
): void {
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(db, { projectId: row.project_id, status })) {
      if (alert.issue_id !== row.id || !alert.alert_type.startsWith(WATCHDOG_ALERT_PREFIX) ||
        alert.run_group_id === activeStateKey) continue;
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: alert.evidence_json,
        message: `issue #${row.id} watchdog condition recovered`,
        watchdog_seen_at: now.toISOString()
      });
    }
  }
}

function resolveInactiveWatchdogAlerts(db: RunnerDatabase, cutoff: string, now: Date): void {
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(db, { status })) {
      if (!alert.alert_type.startsWith(WATCHDOG_ALERT_PREFIX) || alert.issue_id <= 0) continue;
      if (issueStillWatchdogCandidate(db, alert.issue_id, cutoff)) continue;
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: alert.evidence_json,
        message: `issue #${alert.issue_id} watchdog condition recovered`,
        watchdog_seen_at: now.toISOString()
      });
    }
  }
}

function issueStillWatchdogCandidate(db: RunnerDatabase, issueID: number, cutoff: string): boolean {
  return (db.sqlite.query<{ active: number }, [number, string]>(`
    select exists(
      select 1 from issues i join projects p on p.id=i.project_id
      where i.id=? and p.auto_run=1 and i.status='todo'
        and coalesce(nullif(i.updated_at, ''), i.created_at)<=?
        and not exists (select 1 from issue_runs ir where ir.issue_id=i.id and ir.ended_at='')
        and not exists (
          select 1 from agent_sessions s where s.issue_id=i.id
            and lower(replace(replace(replace(s.status, '_', ''), '-', ''), ' ', ''))
              in ('active', 'busy', 'inprogress', 'running')
        )
    ) as active
  `).get(issueID, cutoff)?.active ?? 0) === 1;
}

function watchdogAttentionMessage(row: StaleTodoRow, state: WatchdogState): string {
  const next = state.nextCheckAt ? ` next_check_at=${state.nextCheckAt}` : "";
  return `issue #${row.id} watchdog wait: ${state.reason}; root_blocker=${JSON.stringify(state.rootBlocker)}.${next}`;
}

function statePayload(state: WatchdogState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authority: state.authority,
    next_check_at: state.nextCheckAt,
    not_runnable_reason: state.reason === "ready" ? "" : state.reason,
    root_blocker: state.rootBlocker,
    state_key: state.stateKey,
    ...extra
  };
}

function latestWatchdogState(db: RunnerDatabase, issueID: number): StoredWatchdogState {
  const row = db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events
    where issue_id=? and type in ('issue.watchdog_kicked', 'issue.watchdog_needs_user', 'issue.watchdog_waiting')
    order by id desc limit 1
  `).get(issueID);
  return { stateKey: cleanString(parsePayload(row?.payload).state_key) };
}

function providerRuntimeBlocker(db: RunnerDatabase, provider: string): Record<string, unknown> {
  const row = db.sqlite.query<{
    event_id: number; issue_id: number; next_check_at: string; payload: string;
  }, [string]>(`
    select event.id as event_id, event.issue_id, i.auto_retry_next_at as next_check_at, event.payload
    from issue_events event
    join issues i on i.id=event.issue_id
    where event.type='issue.provider_deferred'
      and i.auto_retry_reason=?
    order by event.id desc limit 1
  `).get(`provider_infra_transient:${provider}`);
  if (!row) return { provider };
  return {
    event_id: row.event_id,
    issue_id: row.issue_id,
    next_check_at: row.next_check_at || cleanString(parsePayload(row.payload).next_check_at),
    provider
  };
}

function activeCapacityBlockers(db: RunnerDatabase): Array<Record<string, unknown>> {
  return db.sqlite.query<{ id: number; project_id: string; status: string }, []>(`
    select distinct i.id, i.project_id, i.status
    from issues i left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where (i.status='in_progress' or ir.id is not null)
      and not (ir.id is not null and exists (
        select 1 from issue_events event
        where event.issue_id=i.id and event.type='issue.provider_deferred'
          and event.created_at>=ir.started_at
      ))
    order by i.id limit 10
  `).all().map((row) => ({ issue_id: row.id, project_id: row.project_id, status: row.status }));
}

function activeProjectBlockers(db: RunnerDatabase, projectID: string): Array<Record<string, unknown>> {
  const cwd = cleanString(getProject(db, projectID)?.cwd);
  return db.sqlite.query<{ id: number; project_id: string; status: string }, [string, string, string]>(`
    select distinct i.id, i.project_id, i.status
    from issues i
    join projects p on p.id=i.project_id
    left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where (i.project_id=? or (?<>'' and trim(p.cwd)=?))
      and (i.status='in_progress' or ir.id is not null)
    order by i.id limit 10
  `).all(projectID, cwd, cwd).map((row) => ({
    issue_id: row.id,
    project_id: row.project_id,
    status: row.status
  }));
}

function publishNeedsUser(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  now: Date,
  diagnosis: "todo_without_session",
  stateKey: string
): boolean {
  return publishPiNeedsUserNotification({
    actionID: `${stateKey}:${diagnosis}`,
    bus: input.bus,
    database: input.database,
    diagnosis,
    issue: { id: row.id, project_id: row.project_id, status: row.status, title: row.title },
    message: `issue #${row.id} 停在 todo，watchdog kick 后仍没有 open run 或 active session。`,
    nextStep: "请检查 runner loop/provider 状态；恢复后 retry 或重新触发项目执行。",
    now,
    project: { id: row.project_id, name: row.project_name },
    provider: row.provider
  }) !== null;
}

function lastWatchdogKickAt(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ created_at: string }, [number]>(`
    select created_at from issue_events
    where issue_id=? and type='issue.watchdog_kicked'
    order by created_at desc, id desc limit 1
  `).get(issueID)?.created_at ?? "";
}

function watchdogKickAttempts(db: RunnerDatabase, issueID: number, stateKey: string): number {
  return db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events
    where issue_id=? and type='issue.watchdog_kicked'
      and json_valid(payload) and json_extract(payload, '$.state_key')=?
  `).get(issueID, stateKey)?.count ?? 0;
}

function recordWatchdogEvent(
  db: RunnerDatabase,
  issueID: number,
  type: "issue.watchdog_kicked" | "issue.watchdog_needs_user" | "issue.watchdog_waiting",
  payload: Record<string, unknown>,
  now: Date
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), now.toISOString()]
  );
}

function listStaleTodoWithoutRuntime(
  db: RunnerDatabase,
  cutoff: string,
  now: string,
  limit: number
): StaleTodoRow[] {
  return db.sqlite.query<StaleTodoRow, [string, string, number]>(`
    select i.id, i.project_id, i.title, i.status, i.created_at, i.updated_at,
           p.name as project_name, p.provider
    from issues i
    join projects p on p.id=i.project_id
    where p.auto_run=1
      and i.status='todo'
      and (
        coalesce(nullif(i.updated_at, ''), i.created_at) <= ?
        or (
          i.auto_retry_reason like 'provider_infra_transient:%'
          and i.auto_retry_next_at<>''
          and i.auto_retry_next_at<=?
        )
      )
      and not exists (
        select 1 from issue_runs ir where ir.issue_id=i.id and ir.ended_at=''
      )
      and not exists (
        select 1 from agent_sessions s
        where s.issue_id=i.id
          and lower(replace(replace(replace(s.status, '_', ''), '-', ''), ' ', ''))
            in ('active', 'busy', 'inprogress', 'running')
      )
    order by i.updated_at asc, i.created_at asc, i.id asc
    limit ?
  `).all(cutoff, now, limit);
}

function uniqueProjectRows(rows: StaleTodoRow[]): StaleTodoRow[] {
  return [...new Map(rows.map((row) => [row.project_id, row])).values()];
}

function rowFromDecision(candidate: StaleTodoRow, decision: ProjectLoopDecision): StaleTodoRow {
  const issue = decision.issue;
  if (!issue) return candidate;
  return {
    ...candidate,
    created_at: issue.created_at,
    id: issue.id,
    project_id: issue.project_id,
    provider: decision.provider || candidate.provider,
    status: issue.status,
    title: issue.title,
    updated_at: issue.updated_at
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hash(value: string): string {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(36);
}

function nextCheck(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}

function cutoffISO(now: Date, staleAfterMs: number): string {
  return new Date(now.getTime() - staleAfterMs).toISOString();
}

function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
