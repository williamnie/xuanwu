import type { RunnerDatabase } from '../db/database.ts';
import { workFacts, sumKnown, FACT_LIMIT, JSON_LIMIT, type Candidate, type WorkFacts } from './deliveryEffectivenessFacts.ts';

export type DeliveryQuery = { project_id?: string; task_type?: string; from?: string; to?: string; limit?: number; before_issue_id?: number };
const CANDIDATE_LIMIT = 500;
const TIME_BUDGET_MS = 200;

/** 只读、有界的账本投影。分组与趋势仅描述当前页；游标推进候选，空页也可继续。 */
export function buildDeliveryEffectiveness(db: RunnerDatabase, now: Date, query: DeliveryQuery = {}) {
  const steps = deliverySteps(db, now, query);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

// HTTP 每个候选之间让出事件循环，沿用同步投影供现有隔离 observability reader 使用。
export async function buildDeliveryEffectivenessAsync(db: RunnerDatabase, now: Date, query: DeliveryQuery = {}) {
  const steps = deliverySteps(db, now, query);
  let result = steps.next(), yieldedAt = performance.now();
  while (!result.done) {
    if (performance.now() - yieldedAt >= 4) {
      await new Promise(resolve => setTimeout(resolve, 0));
      yieldedAt = performance.now();
    }
    result = steps.next();
  }
  return result.value;
}

function* deliverySteps(db: RunnerDatabase, now: Date, query: DeliveryQuery) {
  const started = performance.now();
  const until = query.to ?? now.toISOString();
  const since = query.from ?? new Date(Date.parse(until) - 30 * 86400_000).toISOString();
  const limit = Math.max(1, Math.min(100, query.limit ?? 100));
  const candidates = db.sqlite.query<Candidate, [number, number]>(`select i.id,i.status,i.project_id,
    coalesce(nullif(w.type,''),'engineering_task') as task_type
    from issues i left join works w on w.id='xw:work:issues:'||i.id
    where i.id<? order by i.id desc limit ?`).all(query.before_issue_id ?? Number.MAX_SAFE_INTEGER, CANDIDATE_LIMIT + 1);
  const samples: WorkFacts[] = [];
  let scanned = 0, cursor: number | null = null;
  for (const candidate of candidates.slice(0, CANDIDATE_LIMIT)) {
    // 总时间预算在一个 Work 的原子读取之间检查，保留至少一次推进。
    if (scanned > 0 && (samples.length >= limit || performance.now() - started >= TIME_BUDGET_MS)) break;
    yield;
    scanned++; cursor = candidate.id;
    if (!['done', 'failed', 'cancelled'].includes(candidate.status)
      || (query.project_id && candidate.project_id !== query.project_id)
      || (query.task_type && candidate.task_type !== query.task_type)) continue;
    const latest = db.sqlite.query<{ id: string; run_id: string; started_at: string; ended_at: string }, [number]>(
      'select id,run_id,started_at,ended_at from issue_runs where issue_id=? order by attempt desc limit 1').get(candidate.id);
    if (!latest || !Number.isFinite(Date.parse(latest.ended_at))
      || Date.parse(latest.ended_at) < Date.parse(since) || Date.parse(latest.ended_at) > Date.parse(until)) continue;
    samples.push(workFacts(db, candidate, latest));
  }
  const hasMore = scanned < candidates.length;
  return {
    contract: 'xw.delivery-effectiveness.v2', generated_at: now.toISOString(), since, until,
    filters: { project_id: query.project_id ?? null, task_type: query.task_type ?? null },
    sample_limit: limit, truncated: hasMore, has_more: hasMore, next_before_issue_id: hasMore ? cursor : null,
    aggregation_scope: 'page', ...summarize(samples), samples,
    by_project: groups(samples, s => s.project_id), by_type: groups(samples, s => s.task_type),
    trend: groups(samples, s => s.ended_at.slice(0, 10)),
    query_budget: { candidate_limit: CANDIDATE_LIMIT, scanned_candidates: scanned, time_budget_ms: TIME_BUDGET_MS,
      elapsed_ms: Math.round(performance.now() - started), per_source_limit: FACT_LIMIT, max_json_bytes: JSON_LIMIT },
    coverage: {
      cohort: 'terminal Issue-backed Work; latest Run ended in range; current persisted facts; descending Issue id cursor',
      aggregation: 'page only; continue all pages with identical filters and range before comparing complete cohorts',
      task_type: 'works.type; Issue adapter fallback engineering_task; no inferred task categories',
      delivery: 'done Work with latest ready/delivered Handoff, passed linked Evidence and required delivery actions succeeded',
      help: 'recorded approval requests or requires_user notification intents; absence does not prove no manual intervention',
      waiting: 'run gaps and recorded resolved approval intervals only; may overlap; total waiting and time saved unknown',
      cost: 'executor reported money; every Run/attempt required; missing data or within-Work currency conflicts unknown',
      supervisor: 'recorded memory reflection SDK estimates only; partial receipts are subtotals; all other Supervisor costs unknown',
      memory: 'injection is prepared input; citation is executor self-report; effective reuse and causal time savings unknown',
      facts: 'bounded source records; limited_sources identifies incomplete facts; missing audit is unknown, not zero activity',
    },
  };
}

function summarize(samples: WorkFacts[]) {
  const completed = samples.filter(s => s.status === 'done');
  const delivered = samples.filter(s => s.delivered);
  const recovered = samples.filter(s => (s.recoveries ?? 0) > 0);
  const durations = completed.map(s => s.elapsed_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const currencies = new Map<string, { currency: string; amount_micros: number; works: number }>();
  for (const s of completed) if (s.cost.status === 'known') {
    const c = s.cost.currency!;
    const row = currencies.get(c) ?? { currency: c, amount_micros: 0, works: 0 };
    row.amount_micros += s.cost.amount_micros!; row.works++; currencies.set(c, row);
  }
  const noHelp = delivered.filter(s => s.asked_for_help === false).length;
  return {
    sampled_works: samples.length, completed_works: completed.length, delivered_works: delivered.length,
    delivery_rate: rate(delivered.length, samples.length), without_help_delivery_rate: rate(noHelp, samples.length),
    without_help_delivered_works: noHelp, help_requested_works: samples.filter(s => s.asked_for_help).length,
    intervention: { unattended_works: null, no_help_record_works: samples.filter(s => s.asked_for_help === false).length, unknown_works: samples.filter(s => s.asked_for_help === null).length },
    recovery: { works: recovered.length, delivered_works: recovered.filter(s => s.delivered).length,
      delivery_rate: rate(recovered.filter(s => s.delivered).length, recovered.length),
      no_progress_attempts: sumKnown(samples.map(s => s.no_progress)),
      repeated_no_progress_works: samples.filter(s => (s.no_progress ?? 0) >= 2).length,
      repeated_run_works: samples.filter(s => (s.run_count ?? 0) > 1).length,
      unknown_works: samples.filter(s => s.recoveries === null).length },
    duration: { known_works: durations.length, median_ms: median(durations) },
    waiting: { run_gap_ms: sumKnown(samples.map(s => s.waiting.run_gap_ms)),
      run_gap_known_works: samples.filter(s => s.waiting.run_gap_ms !== null).length,
      approval_recorded_ms: sumKnown(samples.map(s => s.waiting.approval_recorded_ms)),
      approval_known_records: samples.reduce((sum, s) => sum + s.waiting.approval_known_records, 0),
      approval_unknown_records: samples.reduce((sum, s) => sum + s.waiting.approval_unknown_records, 0), total_wait_ms: null },
    cost: { known_works: completed.filter(s => s.cost.status === 'known').length,
      unknown_works: completed.filter(s => s.cost.status !== 'known').length,
      by_currency: [...currencies.values()].map(row => ({ ...row, mean_micros: row.amount_micros / row.works })) },
    memory: { audit_covered_works: samples.filter(s => s.memory.audit_events > 0).length,
      no_audit_record_works: samples.filter(s => s.memory.audit_events === 0).length,
      injected_works: samples.filter(s => s.memory.injected).length, cited_works: samples.filter(s => s.memory.cited).length,
      injection_estimated_token_count: sumKnown(samples.map(s => s.memory.injection_estimated_token_count)),
      retrieval_elapsed_ms: sumKnown(samples.map(s => s.memory.retrieval_elapsed_ms)), evidence_supported_reuse: null },
    supervisor: { total_cost: null, reflection: {
      recorded_attempts: samples.reduce((sum, s) => sum + s.reflection.recorded_attempts, 0),
      known_cost_usd: sumKnown(samples.map(s => s.reflection.known_cost_usd)),
      cost_known_attempts: samples.reduce((sum, s) => sum + s.reflection.cost_known_attempts, 0),
      elapsed_ms: sumKnown(samples.map(s => s.reflection.elapsed_ms)),
      input_tokens: sumKnown(samples.map(s => s.reflection.input_tokens)), output_tokens: sumKnown(samples.map(s => s.reflection.output_tokens)),
      partial_attempts: samples.reduce((sum, s) => sum + s.reflection.partial_attempts, 0) } },
    execution_cost: allWorkCost(samples),
    data_coverage: { limited_works: samples.filter(s => s.limited_sources.length > 0).length,
      delivery_known_works: samples.filter(s => s.delivery_data !== 'unknown').length,
      cost_known_works: completed.filter(s => s.cost.status === 'known').length, cost_eligible_works: completed.length },
  };
}
function groups(samples: WorkFacts[], key: (s: WorkFacts) => string) {
  const map = new Map<string, WorkFacts[]>();
  for (const sample of samples) { const k = key(sample); const group = map.get(k) ?? []; group.push(sample); map.set(k, group); }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ key, ...summarize(rows), work_ids: rows.map(s => s.work_id) }));
}
function rate(n: number, d: number) { return d ? n / d : null; }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const index = Math.floor(values.length / 2);
  return values.length % 2 ? values[index] : (values[index - 1] + values[index]) / 2;
}

function allWorkCost(samples: WorkFacts[]) {
  const currencies = new Map<string, { currency: string; amount_micros: number; works: number }>();
  for (const sample of samples) if (sample.cost.status === 'known') {
    const currency = sample.cost.currency!;
    const row = currencies.get(currency) ?? { currency, amount_micros: 0, works: 0 };
    row.amount_micros += sample.cost.amount_micros!; row.works++; currencies.set(currency, row);
  }
  return { known_works: samples.filter(s => s.cost.status === 'known').length,
    unknown_works: samples.filter(s => s.cost.status !== 'known').length, by_currency: [...currencies.values()] };
}
