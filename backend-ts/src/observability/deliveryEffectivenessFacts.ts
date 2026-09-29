import { Value } from '@sinclair/typebox/value';
import type { RunnerDatabase } from '../db/database.ts';
import { HANDOFF_RECORD_EVENT_TYPES } from '../db/repositories/handoffs.ts';
import { HANDOFF_SCHEMA, type HandoffRecord } from '../domain/handoff/contracts.ts';
import { validateEvidence, type EvidenceRecord } from '../domain/evidence/contracts.ts';

export const FACT_LIMIT = 64;
export const JSON_LIMIT = 16_384;
const MEMORY_TYPES = ['issue.run_memory_snapshot.v1', 'issue.run_memory_injected.v1',
  'issue.run_memory_cited.v1', 'issue.memory_reflection_attempt.v1', 'issue.memory_reflection_trigger.v1'];
const EVIDENCE_TYPES = ['evidence.recorded.v1', 'issue.verification_human_evidence.v1'];
type Event = { id: number; type: string; payload: string | null };
type Run = { id: string; run_id: string; started_at: string; ended_at: string };
export type Candidate = { id: number; status: string; project_id: string; task_type: string };
export type Money = { status: 'known' | 'unknown'; reason: string | null; currency: string | null; amount_micros: number | null };
export function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  const sum = known.reduce((a, b) => a + b, 0);
  return known.length && Number.isFinite(sum) ? sum : null;
}
function elapsed(start: string, end: string): number | null { return number(Date.parse(end) - Date.parse(start)); }
const unknownMoney = (reason: string): Money => ({ status: 'unknown', reason, currency: null, amount_micros: null });
export function completeCost(rows: { cost_json: string | null }[], truncated: boolean): Money {
  if (truncated) return unknownMoney('query_budget');
  if (!rows.length) return unknownMoney('missing_attempt');
  let currency = '', amount = 0;
  for (const row of rows) {
    const money = object(object(row.cost_json).money);
    const next = typeof money.currency === 'string' ? money.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(next) || number(money.amount_micros) === null) return unknownMoney('missing_or_invalid_money');
    if (currency && currency !== next) return unknownMoney('currency_conflict');
    currency = next; amount += money.amount_micros as number;
    if (!Number.isSafeInteger(amount)) return unknownMoney('invalid_money_total');
  }
  return { status: 'known', reason: null, currency, amount_micros: amount };
}

/** 按既有索引逐来源读有限记录，先裁剪 JSON，再做白名单投影。 */
export function workFacts(db: RunnerDatabase, candidate: Candidate, latest: Run) {
  const refs: string[] = [];
  const limited: string[] = [];
  const runsRaw = db.sqlite.query<Run, [number, number]>(`select id,run_id,started_at,ended_at from issue_runs
    where issue_id=? order by attempt desc limit ?`).all(candidate.id, FACT_LIMIT + 1);
  if (runsRaw.length > FACT_LIMIT) limited.push('runs');
  const runs = runsRaw.slice(0, FACT_LIMIT);
  const runIDs = runs.map(r => r.run_id);
  const events: Event[] = [];
  for (const type of [...HANDOFF_RECORD_EVENT_TYPES, ...EVIDENCE_TYPES, ...MEMORY_TYPES]) {
    const rows = db.sqlite.query<Event, [number, string, number]>(`select id,type,
      case when length(cast(payload as blob))<=${JSON_LIMIT} then payload else null end as payload
      from issue_events where issue_id=? and type=? order by id desc limit ?`).all(candidate.id, type, FACT_LIMIT + 1);
    if (rows.length > FACT_LIMIT) limited.push(type);
    events.push(...rows.slice(0, FACT_LIMIT));
  }
  events.sort((a, b) => b.id - a.id);
  const invalid = events.filter(e => !Object.keys(object(e.payload)).length);
  if (invalid.length) limited.push('invalid_or_oversized_events');
  const handoffEvent = events.find(e => (HANDOFF_RECORD_EVENT_TYPES as readonly string[]).includes(e.type));
  const rawHandoff = object(handoffEvent?.payload).handoff;
  const handoff = Value.Check(HANDOFF_SCHEMA, rawHandoff) ? rawHandoff as HandoffRecord : null;
  const evidence = new Map<string, EvidenceRecord>();
  // 结构化 Evidence 优先于旧版；每个 id 取最新记录。
  for (const type of EVIDENCE_TYPES) for (const event of events.filter(e => e.type === type)) {
    const value = object(event.payload).evidence;
    if (validateEvidence(value).ok) {
      const item = value as EvidenceRecord;
      if (!evidence.has(item.id)) { evidence.set(item.id, item); refs.push(`issue_event:${event.id}`); }
    }
  }
  if (handoffEvent) refs.push(`issue_event:${handoffEvent.id}`);
  const workID = `xw:work:issues:${candidate.id}`;
  const deliveryIncomplete = !handoff || handoff.evidence_ids.some(id => !evidence.has(id))
    || invalid.some(e => [...HANDOFF_RECORD_EVENT_TYPES, ...EVIDENCE_TYPES].includes(e.type));
  const delivered = !deliveryIncomplete && candidate.status === 'done' && !!handoff && handoff.work_id === workID
    && handoff.run_ids.includes(latest.run_id as typeof handoff.run_ids[number])
    && ['ready', 'delivered'].includes(handoff.status) && handoff.evidence_ids.length > 0
    && handoff.delivery_actions.every(a => !a.required || a.outcome === 'succeeded')
    && handoff.evidence_ids.every(id => evidence.get(id)?.status === 'passed' && evidence.get(id)?.work_id === workID);

  const approvals = db.sqlite.query<{ approval_id: string; created_at: string; resolved_at: string }, [number, number]>(
    'select approval_id,created_at,resolved_at from pi_approval_requests where issue_id=? limit ?').all(candidate.id, FACT_LIMIT + 1);
  const notificationRows = db.sqlite.query<{ id: string; requires_user: number }, [number, number]>(
    'select id,requires_user from pi_notification_intents where issue_id=? limit ?').all(candidate.id, FACT_LIMIT + 1);
  const notifications = notificationRows.slice(0, FACT_LIMIT).filter(n => n.requires_user === 1);
  const recoveryRows = db.sqlite.query<{ id: string; status: string }, [number, number]>(
    'select id,status from pi_recovery_attempts where issue_id=? limit ?').all(candidate.id, FACT_LIMIT + 1);
  const recoveries = recoveryRows.slice(0, FACT_LIMIT).filter(r => ['progress','no_progress','failed'].includes(r.status));
  for (const [name, rows] of [['approvals', approvals], ['notifications', notificationRows], ['recoveries', recoveryRows]] as const) {
    if (rows.length > FACT_LIMIT) limited.push(name);
  }
  refs.push(...approvals.slice(0, FACT_LIMIT).map(a => `pi_approval_requests:${a.approval_id}`),
    ...notifications.slice(0, FACT_LIMIT).map(n => `pi_notification_intents:${n.id}`),
    ...recoveries.slice(0, FACT_LIMIT).map(r => `pi_recovery_attempts:${r.id}`));
  const costs: { cost_json: string | null }[] = [];
  for (const run of runs) {
    const remaining = FACT_LIMIT - costs.length;
    if (remaining <= 0) { limited.push('attempts'); break; }
    const rows = db.sqlite.query<{ id: string; cost_json: string | null }, [string, number]>(`select attempt_id as id,
      case when length(cast(cost_json as blob))<=${JSON_LIMIT} then cost_json else null end as cost_json
      from run_attempts where run_id=? order by sequence limit ?`).all(run.run_id, remaining + 1);
    if (rows.length > remaining) limited.push('attempts');
    refs.push(...rows.slice(0, remaining).map(a => `run_attempts:${a.id}`));
    costs.push(...(rows.length ? rows.slice(0, remaining) : [{ cost_json: null }]));
  }
  const ordered = [...runs].reverse();
  const times = ordered.map(r => elapsed(r.started_at, r.ended_at));
  const gaps = ordered.slice(1).map((r, index) => elapsed(ordered[index].ended_at, r.started_at));
  const timeComplete = !limited.includes('runs') && times.every(v => v !== null) && gaps.every(v => v !== null);
  const approvalTimes = approvals.slice(0, FACT_LIMIT).map(a => elapsed(a.created_at, a.resolved_at));
  const memoryEvents = events.filter(e => MEMORY_TYPES.includes(e.type));
  refs.push(...memoryEvents.map(e => `issue_event:${e.id}`));
  const memory = memoryEvents.map(e => ({ type: e.type, payload: object(e.payload) }));
  const reflection = memory.filter(e => e.type === MEMORY_TYPES[3]);
  const injected = memory.filter(e => e.type === MEMORY_TYPES[1] && typeof e.payload.issue_run_id === 'string');
  return {
    issue_id: candidate.id, work_id: workID, project_id: candidate.project_id, task_type: candidate.task_type,
    status: candidate.status, ended_at: new Date(latest.ended_at).toISOString(), run_ids: runIDs, delivered,
    delivery_data: deliveryIncomplete ? 'unknown' : (delivered ? 'confirmed' : 'not_confirmed'),
    handoff_id: handoff?.id ?? null, evidence_ids: handoff?.evidence_ids ?? [], audit_refs: refs,
    run_count: limited.includes('runs') ? null : runs.length,
    elapsed_ms: timeComplete ? elapsed(ordered[0].started_at, latest.ended_at) : null,
    waiting: { run_gap_ms: timeComplete ? (sumKnown(gaps) ?? 0) : null,
      approval_recorded_ms: sumKnown(approvalTimes), approval_known_records: approvalTimes.filter(v => v !== null).length,
      approval_unknown_records: approvalTimes.filter(v => v === null).length, total_wait_ms: null },
    asked_for_help: approvals.length > 0 || notifications.length > 0 ? true : limited.includes('notifications') ? null : false,
    recoveries: limited.includes('recoveries') ? null : recoveries.length,
    no_progress: limited.includes('recoveries') ? null : recoveries.filter(r => r.status === 'no_progress').length,
    cost: completeCost(costs, limited.includes('runs') || limited.includes('attempts')),
    memory: { audit_events: memoryEvents.length, injected: injected.length > 0,
      cited: memory.some(e => e.type === MEMORY_TYPES[2] && typeof e.payload.issue_run_id === 'string'), evidence_supported_reuse: null,
      injection_estimated_token_count: sumKnown(injected.map(e => number(e.payload.prompt_section_token_estimate))),
      retrieval_elapsed_ms: sumKnown(memory.filter(e => e.type === MEMORY_TYPES[0]).map(e => number(object(object(e.payload.memory).retrieval).elapsed_ms))) },
    reflection: { recorded_attempts: reflection.length,
      known_cost_usd: sumKnown(reflection.map(e => number(object(e.payload.usage).cost_usd))),
      cost_known_attempts: reflection.filter(e => number(object(e.payload.usage).cost_usd) !== null).length,
      elapsed_ms: sumKnown(reflection.map(e => number(e.payload.elapsed_ms))),
      input_tokens: sumKnown(reflection.map(e => number(object(e.payload.usage).input_tokens))),
      output_tokens: sumKnown(reflection.map(e => number(object(e.payload.usage).output_tokens))),
      partial_attempts: reflection.filter(e => object(e.payload.usage).completeness === 'partial').length },
    limited_sources: [...new Set(limited)],
  };
}
export type WorkFacts = ReturnType<typeof workFacts>;
