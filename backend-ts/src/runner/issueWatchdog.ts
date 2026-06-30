import type { RunnerDatabase } from "../db/database.ts";
import { countActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import { startProjectLoop } from "./projectLoopManager.ts";

export type IssueWatchdogSummary = {
  candidates: number;
  escalated: number;
  kicked: number;
  recentlyKicked: number;
  scanned: number;
  skippedBusy: number;
};

export type IssueWatchdogInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  escalateAfterMs?: number;
  limit?: number;
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

const DEFAULT_ESCALATE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

export async function runAutoRunIssueWatchdogOnce(input: IssueWatchdogInput): Promise<IssueWatchdogSummary> {
  const now = optionalDate(input.now) ?? new Date();
  const staleAfterMs = positiveInteger(input.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const escalateAfterMs = positiveInteger(input.escalateAfterMs, DEFAULT_ESCALATE_AFTER_MS);
  const rows = listStaleTodoWithoutRuntime(input.database, cutoffISO(now, staleAfterMs), positiveInteger(input.limit, DEFAULT_LIMIT));
  const summary: IssueWatchdogSummary = {
    candidates: 0,
    escalated: 0,
    kicked: 0,
    recentlyKicked: 0,
    scanned: rows.length,
    skippedBusy: 0
  };
  if (rows.length === 0) return summary;
  if (countActiveExecutorWork(input.database) > 0) {
    summary.skippedBusy = rows.length;
    return summary;
  }
  summary.candidates = rows.length;
  for (const row of rows) {
    const kickedBefore = summary.kicked;
    handleStaleTodo(input, row, summary, now, escalateAfterMs);
    if (summary.kicked > kickedBefore) break;
  }
  return summary;
}

function handleStaleTodo(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  summary: IssueWatchdogSummary,
  now: Date,
  escalateAfterMs: number
): void {
  const lastKick = lastWatchdogKickAt(input.database, row.id);
  if (lastKick && now.getTime() - Date.parse(lastKick) < escalateAfterMs) {
    summary.recentlyKicked += 1;
    return;
  }
  if (!input.providers) {
    summary.recentlyKicked += 1;
    return;
  }
  if (!hasProvider(input.providers, row.provider)) {
    if (publishNeedsUser(input, row, now, "provider_not_registered")) {
      recordWatchdogEvent(input.database, row.id, "issue.watchdog_needs_user", { diagnosis: "provider_not_registered" }, now);
      summary.escalated += 1;
    }
    return;
  }
  recordWatchdogEvent(input.database, row.id, "issue.watchdog_kicked", { reason: "todo_without_session" }, now);
  startProjectLoop({
    bus: input.bus,
    database: input.database,
    providers: input.providers
  }, row.project_id);
  summary.kicked += 1;
}

function listStaleTodoWithoutRuntime(db: RunnerDatabase, cutoff: string, limit: number): StaleTodoRow[] {
  return db.sqlite.query<StaleTodoRow, [string, number]>(`
    select i.id, i.project_id, i.title, i.status, i.created_at, i.updated_at,
           p.name as project_name, p.provider
    from issues i
    join projects p on p.id=i.project_id
    where p.auto_run=1
      and i.status='todo'
      and coalesce(nullif(i.updated_at, ''), i.created_at) <= ?
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
  `).all(cutoff, limit);
}

function publishNeedsUser(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  now: Date,
  diagnosis: "provider_not_registered" | "todo_without_session"
): boolean {
  return publishPiNeedsUserNotification({
    actionID: `issue-watchdog:${row.id}:${diagnosis}`,
    bus: input.bus,
    database: input.database,
    diagnosis,
    issue: { id: row.id, project_id: row.project_id, status: row.status, title: row.title },
    message: needsUserMessage(row, diagnosis),
    nextStep: needsUserNextStep(diagnosis),
    now,
    project: { id: row.project_id, name: row.project_name },
    provider: row.provider
  }) !== null;
}

function needsUserMessage(row: StaleTodoRow, diagnosis: "provider_not_registered" | "todo_without_session"): string {
  if (diagnosis === "provider_not_registered") {
    return `issue #${row.id} 位于 auto_run 项目 ${row.project_id}，但当前调度器没有注册 provider ${row.provider}。`;
  }
  return `issue #${row.id} 停在 todo，watchdog kick 后仍没有 open run 或 active session。`;
}

function needsUserNextStep(diagnosis: "provider_not_registered" | "todo_without_session"): string {
  if (diagnosis === "provider_not_registered") return "请检查 runner providers 配置并重新部署/重启调度器。";
  return "请检查 runner loop/provider 状态；恢复后 retry 或重新触发项目执行。";
}

function lastWatchdogKickAt(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ created_at: string }, [number]>(`
    select created_at from issue_events
    where issue_id=? and type='issue.watchdog_kicked'
    order by created_at desc, id desc limit 1
  `).get(issueID)?.created_at ?? "";
}

function recordWatchdogEvent(
  db: RunnerDatabase,
  issueID: number,
  type: "issue.watchdog_kicked" | "issue.watchdog_needs_user",
  payload: Record<string, unknown>,
  now: Date
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), now.toISOString()]
  );
}

function hasProvider(
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>> | undefined,
  provider: string
): boolean {
  const id = provider.trim();
  return isExecutorProviderId(id) && providers?.[id] !== undefined;
}

function cutoffISO(now: Date, staleAfterMs: number): string {
  return new Date(now.getTime() - staleAfterMs).toISOString();
}

function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  return typeof value === "string" && value.trim() !== "" ? new Date(value) : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
