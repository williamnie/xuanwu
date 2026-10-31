import type { RunnerDatabase } from "../db/database.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { redactRegisteredSecrets } from "../security/redactionRegistry.ts";
import { listEventSummaryProjectionForRead } from "../db/repositories/compactEventSummaryProjection.ts";
import type { TraceRow, EventRow } from "./runtimeObservability.model.ts";

export function traceRows(database: RunnerDatabase): TraceRow[] {
  return database.sqlite.query<TraceRow, []>(`
    select issue.id as issue_id, issue.project_id, run.work_id, run.run_id, run.status as run_status,
      run.started_at, run.ended_at, coalesce(latest.provider, run.provider) as provider,
      coalesce(latest.provider_invocation_ref, '') as provider_invocation_ref,
      coalesce(latest.provider_session_id, run.provider_session_id, '') as provider_session_id,
      coalesce(link.workflow_ref, work.workflow_ref,
        'workflow:implement@1') as workflow_ref,
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

export function traceView(row: TraceRow): Record<string, unknown> {
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

export function structuredEventRows(database: RunnerDatabase): EventRow[] {
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

export function structuredEventView(row: EventRow): Record<string, unknown> {
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

export function canonicalRunID(value: string): string {
  if (!value) return "";
  return value.startsWith("xw:run:") ? value : `xw:run:issue_runs:${value}`;
}

export function safeSummaryPayload(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return sanitizeDiagnosticValue(redactRegisteredSecrets(parsed)) as Record<string, unknown>;
  } catch {
    return { diagnostic: "invalid summary projection payload" };
  }
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, sanitizeDiagnosticValue(child)]));
  }
  return typeof value === "string" ? redactedUserVisibleText(value) : value;
}

export function eventSeverity(eventType: string): "error" | "info" | "warning" {
  const value = eventType.toLowerCase();
  if (value.includes("failed") || value.includes("error")) return "error";
  if (value.includes("warning") || value.includes("attention") || value.includes("blocked")) return "warning";
  return "info";
}
