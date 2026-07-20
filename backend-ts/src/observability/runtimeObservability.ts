import type { RunnerDatabase } from "../db/database.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { redactRegisteredSecrets } from "../security/redactionRegistry.ts";
import {
  eventSummaryTypeCountsForRead,
  listEventSummaryProjectionForRead
} from "../db/repositories/compactEventSummaryProjection.ts";

export const RUNTIME_OBSERVABILITY_SCHEMA_VERSION = "xuanwu.runtime-observability.v1" as const;

type CountRow = { count: number; key: string };
type WorkflowRow = { runs: number; updated_at: string; work: number; workflow_ref: string };
type ProviderRow = {
  attempts: number;
  known_usage_attempts: number;
  provider: string;
  total_tokens: number;
};
type MoneyRow = { amount_micros: number; attempts: number; currency: string; provider: string };
type ProviderMetric = ProviderRow & { money_by_currency: Array<Omit<MoneyRow, "provider">> };
type TraceRow = {
  attempt_count: number;
  automation_id: string | null;
  automation_run_id: string | null;
  ended_at: string;
  issue_id: number;
  project_id: string;
  provider: string;
  provider_invocation_ref: string;
  provider_session_id: string;
  run_id: string;
  run_status: string;
  started_at: string;
  usage_completeness: string;
  total_tokens: number;
  work_id: string;
  workflow_ref: string;
};
type EventRow = {
  event_created_at: string;
  event_type: string;
  issue_id: number;
  project_id: string;
  run_id: string;
  source_event_id: number;
  summary: string;
  summary_payload: string;
};

/**
 * Read-only operational projection. Every query uses durable domain tables or
 * event_summary_projection; it never reads provider session JSONL or runtime log files.
 */
export function buildRuntimeObservability(database: RunnerDatabase, now = new Date()): Record<string, unknown> {
  const generatedAt = now.toISOString();
  const workStatuses = statusCounts(database, "issues");
  const runStatuses = statusCounts(database, "issue_runs");
  const automationStatuses = statusCounts(database, "automation_runs");
  const workflows = workflowMetrics(database);
  const providers = providerMetrics(database);
  const traces = traceRows(database).map(traceView);
  const structuredEvents = structuredEventRows(database).map(structuredEventView);
  const eventTypes = eventTypeCounts(database);
  const snapshot = {
    schema_version: RUNTIME_OBSERVABILITY_SCHEMA_VERSION,
    generated_at: generatedAt,
    source_of_truth: {
      work: "issues",
      run: "issue_runs+run_attempts",
      workflow: "works+automation_execution_links+issue-template-fallback",
      provider_cost: "run_attempts.cost_json",
      automation: "automation_definitions+automation_runs+automation_execution_links",
      structured_events: "event_summary_projection"
    },
    query_contract: {
      raw_log_scan: false,
      provider_session_scan: false,
      event_payload_source: "event_summary_projection",
      projection_only: true
    },
    dimensions: {
      work: dimension(workStatuses, "issues"),
      run: {
        ...dimension(runStatuses, "issue_runs"),
        attempts: scalar(database, "select count(*) as count from run_attempts")
      },
      workflow: {
        source: "works+automation_execution_links+issue-template-fallback",
        total: workflows.length,
        items: workflows
      },
      provider: {
        source: "run_attempts.cost_json",
        total: providers.length,
        items: providers
      },
      automation: {
        ...dimension(automationStatuses, "automation_runs"),
        definitions: scalar(database, "select count(*) as count from automation_definitions"),
        linked_runs: scalar(database, "select count(*) as count from automation_execution_links")
      }
    },
    cost: aggregateProviderCost(providers),
    health_signals: healthSignals(database, traces, generatedAt),
    trace_correlation: {
      trace_id_contract: "canonical Work id",
      items: traces
    },
    structured_events: {
      source: "event_summary_projection",
      counts_by_type: Object.fromEntries(eventTypes.map((row) => [row.key, row.count])),
      items: structuredEvents
    }
  };
  return redactRegisteredSecrets(snapshot) as Record<string, unknown>;
}

function statusCounts(database: RunnerDatabase, table: "issues" | "issue_runs" | "automation_runs"): CountRow[] {
  return database.sqlite.query<{ count: number; status: string }, []>(`
    select status, count(*) as count from ${table} group by status order by status
  `).all().map((row) => ({ count: Number(row.count), key: String(row.status) }));
}

function eventTypeCounts(database: RunnerDatabase): CountRow[] {
  return eventSummaryTypeCountsForRead(database)
    .map((row) => ({ count: Number(row.count), key: String(row.event_type) }));
}

function dimension(rows: CountRow[], source: string): Record<string, unknown> {
  return {
    source,
    total: rows.reduce((total, row) => total + row.count, 0),
    statuses: Object.fromEntries(rows.map((row) => [row.key, row.count]))
  };
}

function workflowMetrics(database: RunnerDatabase): WorkflowRow[] {
  return database.sqlite.query<WorkflowRow, []>(`
    select
      coalesce(nullif(link.workflow_ref, ''), nullif(work.workflow_ref, ''),
        'issue-template:' || coalesce(nullif(issue.template_id, ''), 'default')) as workflow_ref,
      count(distinct issue.id) as work,
      count(distinct run.id) as runs,
      max(issue.updated_at) as updated_at
    from issues issue
    left join issue_runs run on run.issue_id=issue.id
    left join works work on work.id=run.work_id
    left join automation_execution_links link on link.run_id=run.run_id
    group by 1
    order by work desc, workflow_ref asc
  `).all().map((row) => ({
    runs: Number(row.runs),
    updated_at: String(row.updated_at ?? ""),
    work: Number(row.work),
    workflow_ref: String(row.workflow_ref)
  }));
}

function providerMetrics(database: RunnerDatabase): ProviderMetric[] {
  const money = providerMoneyRows(database);
  return database.sqlite.query<ProviderRow, []>(`
    select provider,
      count(*) as attempts,
      sum(case when json_type(cost_json, '$.usage.total_tokens') in ('integer','real') then 1 else 0 end) as known_usage_attempts,
      coalesce(sum(case when json_type(cost_json, '$.usage.total_tokens') in ('integer','real')
        then json_extract(cost_json, '$.usage.total_tokens') else 0 end), 0) as total_tokens
    from run_attempts group by provider order by attempts desc, provider asc
  `).all().map((row) => ({
    attempts: Number(row.attempts),
    known_usage_attempts: Number(row.known_usage_attempts),
    money_by_currency: money.filter((item) => item.provider === String(row.provider)).map(({ provider: _provider, ...item }) => item),
    provider: String(row.provider),
    total_tokens: Number(row.total_tokens)
  }));
}

function providerMoneyRows(database: RunnerDatabase): MoneyRow[] {
  return database.sqlite.query<MoneyRow, []>(`
    select provider,
      coalesce(nullif(json_extract(cost_json, '$.money.currency'), ''), 'unknown') as currency,
      count(*) as attempts,
      sum(json_extract(cost_json, '$.money.amount_micros')) as amount_micros
    from run_attempts
    where json_type(cost_json, '$.money.amount_micros') in ('integer','real')
    group by provider, currency order by provider asc, currency asc
  `).all().map((row) => ({
    amount_micros: Number(row.amount_micros),
    attempts: Number(row.attempts),
    currency: String(row.currency),
    provider: String(row.provider)
  }));
}

function aggregateProviderCost(rows: ProviderMetric[]): Record<string, unknown> {
  const attempts = rows.reduce((total, row) => total + row.attempts, 0);
  const knownTokens = rows.reduce((total, row) => total + row.known_usage_attempts, 0);
  const knownMoney = rows.flatMap((row) => row.money_by_currency).reduce((total, row) => total + row.attempts, 0);
  const currencies = new Map<string, { amount_micros: number; attempts: number; currency: string }>();
  for (const money of rows.flatMap((row) => row.money_by_currency)) {
    const current = currencies.get(money.currency) ?? { amount_micros: 0, attempts: 0, currency: money.currency };
    current.amount_micros += money.amount_micros;
    current.attempts += money.attempts;
    currencies.set(money.currency, current);
  }
  return {
    source: "run_attempts.cost_json",
    attempts,
    usage: {
      known_attempts: knownTokens,
      unknown_attempts: Math.max(0, attempts - knownTokens),
      total_tokens: rows.reduce((total, row) => total + row.total_tokens, 0)
    },
    money: {
      by_currency: [...currencies.values()].sort((left, right) => left.currency.localeCompare(right.currency)),
      known_attempts: knownMoney,
      unknown_attempts: Math.max(0, attempts - knownMoney)
    }
  };
}

function traceRows(database: RunnerDatabase): TraceRow[] {
  return database.sqlite.query<TraceRow, []>(`
    select issue.id as issue_id, issue.project_id, run.work_id, run.run_id, run.status as run_status,
      run.started_at, run.ended_at, coalesce(latest.provider, run.provider) as provider,
      coalesce(latest.provider_invocation_ref, '') as provider_invocation_ref,
      coalesce(latest.provider_session_id, run.provider_session_id, '') as provider_session_id,
      coalesce(link.workflow_ref, work.workflow_ref,
        'issue-template:' || coalesce(nullif(issue.template_id, ''), 'default')) as workflow_ref,
      link.automation_id, link.automation_run_id,
      count(attempt.attempt_id) as attempt_count,
      coalesce(sum(case when json_type(attempt.cost_json, '$.usage.total_tokens') in ('integer','real')
        then json_extract(attempt.cost_json, '$.usage.total_tokens') else 0 end), 0) as total_tokens,
      case
        when count(attempt.attempt_id)=0 then 'unavailable'
        when sum(case when json_type(attempt.cost_json, '$.usage.total_tokens') in ('integer','real') then 1 else 0 end)=count(attempt.attempt_id)
          then 'complete'
        when sum(case when json_type(attempt.cost_json, '$.usage.total_tokens') in ('integer','real') then 1 else 0 end)=0
          then 'unavailable'
        else 'partial'
      end as usage_completeness
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    left join run_attempts attempt on attempt.run_id=run.run_id
    left join run_attempts latest on latest.run_id=run.run_id and latest.sequence=(
      select max(candidate.sequence) from run_attempts candidate where candidate.run_id=run.run_id
    )
    left join works work on work.id=run.work_id
    left join automation_execution_links link on link.run_id=run.run_id
    group by run.id
    order by run.started_at desc, run.id desc limit 50
  `).all();
}

function traceView(row: TraceRow): Record<string, unknown> {
  return {
    trace_id: String(row.work_id),
    work: { id: String(row.work_id), issue_id: Number(row.issue_id), project_id: String(row.project_id) },
    run: {
      id: String(row.run_id),
      status: String(row.run_status),
      attempts: Number(row.attempt_count),
      started_at: String(row.started_at),
      ended_at: String(row.ended_at)
    },
    workflow: { ref: String(row.workflow_ref) },
    provider: {
      id: String(row.provider),
      invocation_ref: String(row.provider_invocation_ref),
      session_id: String(row.provider_session_id)
    },
    automation: row.automation_run_id ? {
      id: String(row.automation_id ?? ""),
      run_id: String(row.automation_run_id)
    } : null,
    cost: { usage_completeness: String(row.usage_completeness), total_tokens: Number(row.total_tokens) }
  };
}

function structuredEventRows(database: RunnerDatabase): EventRow[] {
  return listEventSummaryProjectionForRead(database, { limit: 50 }).map((row) => ({
    event_created_at: row.event_created_at,
    event_type: row.event_type,
    issue_id: row.issue_id,
    project_id: row.project_id,
    run_id: row.run_id,
    source_event_id: row.source_event_id,
    summary: row.summary,
    summary_payload: row.summary_payload
  }));
}

function structuredEventView(row: EventRow): Record<string, unknown> {
  return {
    event_id: `issue_events:${Number(row.source_event_id)}`,
    occurred_at: String(row.event_created_at),
    event_type: String(row.event_type),
    severity: eventSeverity(String(row.event_type)),
    trace: {
      work_id: `xw:work:issues:${Number(row.issue_id)}`,
      run_id: canonicalRunID(String(row.run_id ?? "")),
      project_id: String(row.project_id)
    },
    summary: redactedUserVisibleText(String(row.summary ?? "")),
    fields: safeSummaryPayload(String(row.summary_payload ?? ""))
  };
}

function canonicalRunID(value: string): string {
  if (!value) return "";
  return value.startsWith("xw:run:") ? value : `xw:run:issue_runs:${value}`;
}

function safeSummaryPayload(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return sanitizeDiagnosticValue(redactRegisteredSecrets(parsed)) as Record<string, unknown>;
  } catch {
    return { diagnostic: "invalid summary projection payload" };
  }
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, sanitizeDiagnosticValue(child)]));
  }
  return typeof value === "string" ? redactedUserVisibleText(value) : value;
}

function eventSeverity(eventType: string): "error" | "info" | "warning" {
  const value = eventType.toLowerCase();
  if (value.includes("failed") || value.includes("error")) return "error";
  if (value.includes("warning") || value.includes("attention") || value.includes("blocked")) return "warning";
  return "info";
}

function healthSignals(database: RunnerDatabase, traces: Array<Record<string, unknown>>, generatedAt: string): Record<string, unknown> {
  const missingAttempts = scalar(database, `
    select count(*) as count from issue_runs run
    where not exists (select 1 from run_attempts attempt where attempt.run_id=run.run_id)
  `);
  const expiredAutomationLeases = Number(database.sqlite.query<{ count: number }, [string]>(`
    select count(*) as count from automation_runs
    where status='running' and lease_expires_at<>'' and julianday(lease_expires_at)<julianday(?)
  `).get(generatedAt)?.count ?? 0);
  return {
    traceable_runs: traces.length,
    missing_attempt_links: missingAttempts,
    expired_automation_leases: expiredAutomationLeases,
    state: missingAttempts > 0 || expiredAutomationLeases > 0 ? "degraded" : "healthy",
    reasons: [
      ...(missingAttempts > 0 ? [{ code: "run_attempt_link_missing", count: missingAttempts, source_ref: "issue_runs->run_attempts" }] : []),
      ...(expiredAutomationLeases > 0 ? [{ code: "automation_lease_expired", count: expiredAutomationLeases, source_ref: "automation_runs.lease_expires_at" }] : [])
    ]
  };
}

function scalar(database: RunnerDatabase, sql: string): number {
  return Number(database.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0);
}
