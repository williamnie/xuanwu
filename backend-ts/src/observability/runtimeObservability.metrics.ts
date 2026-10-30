import type { RunnerDatabase } from "../db/database.ts";
import { eventSummaryTypeCountsForRead } from "../db/repositories/compactEventSummaryProjection.ts";
import type { CountRow, WorkflowRow, ProviderMetric, ProviderRow, MoneyRow } from "./runtimeObservability.model.ts";

export function statusCounts(database: RunnerDatabase, table: "issues" | "issue_runs" | "automation_runs"): CountRow[] {
  return database.sqlite.query<{ count: number; status: string }, []>(`
    select status, count(*) as count from ${table} group by status order by status
  `).all().map((row) => ({ count: Number(row.count), key: String(row.status) }));
}

export function eventTypeCounts(database: RunnerDatabase): CountRow[] {
  return eventSummaryTypeCountsForRead(database)
    .map((row) => ({ count: Number(row.count), key: String(row.event_type) }));
}

export function dimension(rows: CountRow[], source: string): Record<string, unknown> {
  return {
    source,
    total: rows.reduce((total, row) => total + row.count, 0),
    statuses: Object.fromEntries(rows.map((row) => [row.key, row.count]))
  };
}

export function workflowMetrics(database: RunnerDatabase): WorkflowRow[] {
  return database.sqlite.query<WorkflowRow, []>(`
    select
      coalesce(nullif(link.workflow_ref, ''), nullif(work.workflow_ref, ''),
        'workflow:implement@1') as workflow_ref,
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

export function providerMetrics(database: RunnerDatabase): ProviderMetric[] {
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

export function providerMoneyRows(database: RunnerDatabase): MoneyRow[] {
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

export function aggregateProviderCost(rows: ProviderMetric[]): Record<string, unknown> {
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

export function healthSignals(database: RunnerDatabase, traces: Array<Record<string, unknown>>, generatedAt: string): Record<string, unknown> {
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

export function scalar(database: RunnerDatabase, sql: string): number {
  return Number(database.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0);
}
