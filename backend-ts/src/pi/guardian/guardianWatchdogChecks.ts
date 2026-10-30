import { ROUTABLE_INTENT_SQL } from "./guardianWatchdogMaintenance.ts";
import { type PiGuardianWatchdogContext, type PiGuardianWatchdogCheck, PiRuntimeRow, CountRow, DigestGroupRow, type PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";
import { ok, alert, countAlerts, digestOverdue } from "./guardianWatchdogStatus.ts";

export function piRuntimeChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<PiRuntimeRow, [string, string]>(`
    select project_id, reason, count(*) as count, min(seen_at) as oldest_created_at
    from (
      select s.project_id as project_id,
        case when a.id is null then 'missing_supervisor' else 'disabled_supervisor' end as reason,
        s.updated_at as seen_at
      from project_pi_settings s left join pi_agents a on a.id='runner-default'
      where a.id is null or a.enabled<>1
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
    message: `Supervisor runtime unavailable for project ${row.project_id}: ${row.reason}`,
    project_id: row.project_id
  }));
}

export function coordinatorChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  return staleIntentChecks(context, {
    alertType: "coordinator_stalled",
    component: "coordinator",
    where: `kind<>'digest' and state in ('pending','ready') and (${ROUTABLE_INTENT_SQL})`
  });
}

export function outboxChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string]>(`
    select coalesce(nullif(o.project_id, ''), i.project_id, '') as project_id, count(*) as count,
      min(o.created_at) as oldest_created_at
    from sync_outbox o left join issues i on i.id=o.issue_id
    where o.status in ('pending','queued','retry','sending','failed')
      and o.provider_request_ref='' and o.created_at<=?
      and not (
        o.status='failed' and o.attempt_count=0
        and o.last_error='historical_pending_backfill_suppressed'
        and exists (
          select 1 from pi_notification_intents intent
          where intent.sent_outbox_id=o.id and intent.state='suppressed'
        )
      )
    group by coalesce(nullif(o.project_id, ''), i.project_id, '')
    order by count desc, project_id asc limit ${context.limit}
  `).all(context.cutoffText);
  return countAlerts({
    alertType: "outbox_stalled", component: "outbox", message: "sync outbox stalled", rows
  });
}

export function digestChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<DigestGroupRow, []>(`
    select id, project_id, status, deadline_at, max_interval_minutes,
      last_digest_at, created_at
    from pi_run_groups where status in ('active','partial')
    order by created_at asc limit ${context.limit}
  `).all();
  const due = rows.filter((row) => digestOverdue(row, context.now, context.staleAfterMs));
  const checks = due.map((row) => alert("digest", "digest_flush_stalled", {
    evidence: row,
    message: `digest flush overdue for run group ${row.id}`,
    project_id: row.project_id,
    run_group_id: row.id
  }));
  checks.push(...digestDeliveryChecks(context));
  return checks.length > 0 ? checks : [ok("digest")];
}

export function digestDeliveryChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  const rows = context.db.sqlite.query<CountRow, [string, number]>(`
    select project_id, count(*) as count,
      min(coalesce(nullif(ready_at, ''), created_at)) as oldest_created_at
    from pi_notification_intents
    where kind='digest' and state='ready' and sent_outbox_id=0
      and julianday(coalesce(nullif(ready_at, ''), created_at))<=julianday(?)
    group by project_id order by count desc, project_id asc limit ?
  `).all(context.cutoffText, context.limit);
  return rows.map((row) => alert("digest", "digest_flush_stalled", {
    evidence: { ...row, reason: "ready_notifications_stalled" },
    message: `digest delivery stalled: ${row.count} stale ready notification(s)`,
    project_id: row.project_id
  }));
}

export function approvalChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
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

export function schedulerChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
  if (context.previousLastSeenAt === "") return [ok("scheduler")];
  const previous = Date.parse(context.previousLastSeenAt);
  if (!Number.isFinite(previous) || context.now.getTime() - previous <= context.schedulerStaleAfterMs) {
    return [ok("scheduler")];
  }
  return [alert("scheduler", "scheduler_stalled", {
    evidence: { last_seen_at: context.previousLastSeenAt },
    message: "Supervisor auto-manage scheduler watchdog tick is stale"
  })];
}

export function inboxChecks(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck[] {
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

export function staleIntentChecks(context: PiGuardianWatchdogContext, input: {
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
