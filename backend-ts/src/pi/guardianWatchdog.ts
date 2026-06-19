import type { RunnerDatabase } from "../db/database.ts";
import { getPiGuardianWatchdogStatus, upsertPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import type { PiGuardianDirectFeishuOptions } from "../integrations/feishuGuardianAlerts.ts";
import { writeGuardianWatchdogAlerts, type WatchdogAlertWriteResult } from "./guardianWatchdogAlerts.ts";

export type PiGuardianWatchdogComponent =
  "approval" | "coordinator" | "digest" | "inbox" | "outbox" | "pi_runtime" | "scheduler";

export type PiGuardianWatchdogCheck = {
  alert_type?: string; component: PiGuardianWatchdogComponent; evidence?: unknown;
  issue_id?: number; message?: string; ok: boolean; project_id?: string;
  run_group_id?: string; severity?: string;
};

export type PiGuardianWatchdogProbe = {
  component: PiGuardianWatchdogComponent;
  run(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck | PiGuardianWatchdogCheck[];
};

export type PiGuardianWatchdogContext = {
  cutoffText: string; db: RunnerDatabase; limit: number; now: Date; nowText: string;
  previousLastSeenAt: string; previousLastSuccessAt: string;
  schedulerStaleAfterMs: number; staleAfterMs: number;
};

export type PiGuardianWatchdogInput = {
  checks?: PiGuardianWatchdogProbe[]; limit?: number; now?: Date | string;
  directFeishu?: PiGuardianDirectFeishuOptions;
  schedulerStaleAfterMs?: number; staleAfterMs?: number;
};

export type PiGuardianWatchdogSummary = {
  alerts: number; checks: PiGuardianWatchdogCheck[]; errors: number; scanned: number;
};
type CountRow = { count: number; oldest_created_at: string; project_id: string };
type DigestGroupRow = {
  created_at: string; deadline_at: string; id: string; last_digest_at: string;
  max_interval_minutes: number; project_id: string; status: string;
};
type PiRuntimeRow = CountRow & { reason: string };

const DEFAULT_LIMIT = 20;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_SCHEDULER_STALE_AFTER_MS = 120_000;

const DEFAULT_CHECKS: PiGuardianWatchdogProbe[] = [
  { component: "pi_runtime", run: piRuntimeChecks },
  { component: "coordinator", run: coordinatorChecks },
  { component: "outbox", run: outboxChecks },
  { component: "digest", run: digestChecks },
  { component: "approval", run: approvalChecks },
  { component: "scheduler", run: schedulerChecks },
  { component: "inbox", run: inboxChecks }
];
export async function runPiGuardianWatchdogOnce(
  db: RunnerDatabase,
  input: PiGuardianWatchdogInput = {}
): Promise<PiGuardianWatchdogSummary> {
  const context = watchdogContext(db, input);
  const probes = input.checks ?? DEFAULT_CHECKS;
  const summary: PiGuardianWatchdogSummary = { alerts: 0, checks: [], errors: 0, scanned: 0 };
  const errors: string[] = [];
  for (const probe of probes) {
    summary.scanned += 1;
    const result = await runProbe(db, probe, context, input.directFeishu);
    summary.checks.push(...result.checks);
    summary.alerts += result.alerts;
    if (result.error !== "") {
      summary.errors += 1;
      errors.push(result.error);
    }
  }
  writeStatus({ checks: summary.checks, context, db, errors });
  return summary;
}

async function runProbe(
  db: RunnerDatabase,
  probe: PiGuardianWatchdogProbe,
  context: PiGuardianWatchdogContext,
  directFeishu: PiGuardianDirectFeishuOptions | undefined
): Promise<WatchdogAlertWriteResult & { checks: PiGuardianWatchdogCheck[] }> {
  try {
    const checks = asArray(probe.run(context));
    const writer = await writeGuardianWatchdogAlerts(db, checks, context, directFeishu);
    return { checks, ...writer };
  } catch (error) {
    const message = safeError(error);
    return {
      alerts: 0,
      checks: [{ component: probe.component, evidence: { error: message }, ok: false }],
      error: `${probe.component}: ${message}`
    };
  }
}
function watchdogContext(db: RunnerDatabase, input: PiGuardianWatchdogInput): PiGuardianWatchdogContext {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const staleAfterMs = positiveMs(input.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const previousStatus = getPiGuardianWatchdogStatus(db);
  return {
    cutoffText: iso(new Date(now.getTime() - staleAfterMs)),
    db,
    limit: positiveLimit(input.limit),
    now,
    nowText: iso(now),
    previousLastSeenAt: previousStatus?.last_seen_at ?? "",
    previousLastSuccessAt: previousStatus?.last_success_at ?? "",
    schedulerStaleAfterMs: positiveMs(input.schedulerStaleAfterMs, DEFAULT_SCHEDULER_STALE_AFTER_MS),
    staleAfterMs
  };
}
function piRuntimeChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<PiRuntimeRow, [string, string]>(`
    select project_id, reason, count(*) as count, min(seen_at) as oldest_created_at
    from (
      select s.project_id as project_id,
        case when a.id is null then 'missing_agent' else 'disabled_agent' end as reason,
        s.updated_at as seen_at
      from project_pi_settings s left join pi_agents a on a.id=s.pi_agent_id
      where s.auto_manage=1 and (a.id is null or a.enabled<>1)
      union all
      select c.project_id, 'failed_conversation' as reason, c.updated_at as seen_at
      from pi_conversations c
      where c.project_id<>'' and c.status='failed' and c.updated_at<=?
        and c.updated_at=(
          select max(latest.updated_at) from pi_conversations latest
          where latest.project_id=c.project_id
        )
      union all
      select s.project_id, 'failed_session' as reason, s.updated_at as seen_at
      from agent_sessions s
      where s.agent_role='pi_manager' and lower(s.status) in ('failed','error','failure')
        and s.project_id<>'' and s.updated_at<=?
        and s.updated_at=(
          select max(latest.updated_at) from agent_sessions latest
          where latest.project_id=s.project_id and latest.agent_role='pi_manager'
        )
    )
    group by project_id, reason order by project_id asc, reason asc limit ${context.limit}
  `).all(context.cutoffText, context.cutoffText);
  if (rows.length === 0) return [ok("pi_runtime")];
  return rows.map((row) => alert("pi_runtime", "pi_runtime_down", {
    evidence: row,
    message: `PI runtime unavailable for project ${row.project_id}: ${row.reason}`,
    project_id: row.project_id
  }));
}
function coordinatorChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  return staleIntentChecks(context, {
    alertType: "coordinator_stalled",
    component: "coordinator",
    where: "kind<>'digest' and state in ('pending','ready')"
  });
}
function outboxChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string]>(`
    select coalesce(i.project_id, '') as project_id, count(*) as count,
      min(o.created_at) as oldest_created_at
    from sync_outbox o left join issues i on i.id=o.issue_id
    where o.status in ('pending','queued','retry','sending','failed')
      and o.feishu_message_id='' and o.created_at<=?
    group by coalesce(i.project_id, '')
    order by count desc, project_id asc limit ${context.limit}
  `).all(context.cutoffText);
  return countAlerts({
    alertType: "outbox_stalled", component: "outbox", message: "sync outbox stalled", rows
  });
}
function digestChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<DigestGroupRow, []>(`
    select id, project_id, status, deadline_at, max_interval_minutes,
      last_digest_at, created_at
    from pi_run_groups where status in ('active','partial')
    order by created_at asc limit ${context.limit}
  `).all();
  const due = rows.filter((row) => digestOverdue(row, context.now, context.staleAfterMs));
  if (due.length === 0) return [ok("digest")];
  return due.map((row) => alert("digest", "digest_flush_stalled", {
    evidence: row,
    message: `digest flush overdue for run group ${row.id}`,
    project_id: row.project_id,
    run_group_id: row.id
  }));
}
function approvalChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string]>(`
    select project_id, count(*) as count, min(updated_at) as oldest_created_at
    from pi_approval_requests
    where resolver_status in ('resolve_failed','failed','error') and updated_at<=?
    group by project_id order by count desc, project_id asc limit ${context.limit}
  `).all(context.cutoffText);
  return countAlerts({
    alertType: "approval_fast_path_error", component: "approval", message: "approval resolver errors", rows
  });
}
function schedulerChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  if (context.previousLastSeenAt === "") return [ok("scheduler")];
  const previous = Date.parse(context.previousLastSeenAt);
  if (!Number.isFinite(previous) || context.now.getTime() - previous <= context.schedulerStaleAfterMs) {
    return [ok("scheduler")];
  }
  return [alert("scheduler", "scheduler_stalled", {
    evidence: { last_seen_at: context.previousLastSeenAt },
    message: "PI auto-manage scheduler watchdog tick is stale"
  })];
}
function inboxChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string]>(`
    select project_id, count(*) as count, min(created_at) as oldest_created_at
    from pi_guardian_event_inbox
    where status in ('pending','leased') and created_at<=?
    group by project_id order by count desc, project_id asc limit ${context.limit}
  `).all(context.cutoffText);
  return countAlerts({
    alertType: "guardian_inbox_stalled", component: "inbox", message: "guardian inbox stalled", rows
  });
}
function staleIntentChecks(context: PiGuardianWatchdogContext, input: {
  alertType: string; component: PiGuardianWatchdogComponent; where: string;
}): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string]>(`
    select project_id, count(*) as count, min(created_at) as oldest_created_at
    from pi_notification_intents where ${input.where} and created_at<=?
    group by project_id order by count desc, project_id asc limit ${context.limit}
  `).all(context.cutoffText);
  return countAlerts({
    alertType: input.alertType, component: input.component,
    message: `${input.component} stalled`, rows
  });
}

function countAlerts(input: {
  alertType: string; component: PiGuardianWatchdogComponent; message: string; rows: CountRow[];
}): PiGuardianWatchdogCheck[] {
  if (input.rows.length === 0) return [ok(input.component)];
  return input.rows.map((row) => alert(input.component, input.alertType, {
    evidence: row,
    message: `${input.message}: ${row.count} stale item(s)`,
    project_id: row.project_id
  }));
}

function writeStatus(input: {
  checks: PiGuardianWatchdogCheck[]; context: PiGuardianWatchdogContext;
  db: RunnerDatabase; errors: string[];
}): void {
  upsertPiGuardianWatchdogStatus(input.db, {
    checked_components_json: input.checks,
    last_error: input.errors.join("\n"),
    last_seen_at: input.context.nowText,
    last_success_at: input.errors.length === 0
      ? input.context.nowText
      : input.context.previousLastSuccessAt
  });
}

function digestOverdue(row: DigestGroupRow, now: Date, graceMs: number): boolean {
  const deadline = Date.parse(row.deadline_at);
  const lastDigest = Date.parse(row.last_digest_at);
  if (Number.isFinite(deadline) && deadline + graceMs <= now.getTime()) {
    return !Number.isFinite(lastDigest) || lastDigest < deadline;
  }
  if (!Number.isFinite(row.max_interval_minutes) || row.max_interval_minutes <= 0) return false;
  const anchor = Date.parse(row.last_digest_at || row.created_at);
  return Number.isFinite(anchor) && anchor + row.max_interval_minutes * 60_000 + graceMs <= now.getTime();
}

function alert(component: PiGuardianWatchdogComponent, alertType: string, input: {
  evidence?: unknown; message: string; project_id?: string; run_group_id?: string;
}): PiGuardianWatchdogCheck {
  return { ...input, alert_type: alertType, component, ok: false, severity: "urgent" };
}

function ok(component: PiGuardianWatchdogComponent): PiGuardianWatchdogCheck {
  return { component, ok: true };
}

function asArray(value: PiGuardianWatchdogCheck | PiGuardianWatchdogCheck[]): PiGuardianWatchdogCheck[] {
  return Array.isArray(value) ? value : [value];
}

function safeError(error: unknown): string {
  return redactAuditText(error instanceof Error ? error.message : String(error));
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function positiveLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT;
}

function positiveMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
