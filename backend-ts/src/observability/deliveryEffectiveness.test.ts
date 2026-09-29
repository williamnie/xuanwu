import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type RunnerDatabase } from '../db/database.ts';
import { buildDeliveryEffectiveness } from './deliveryEffectiveness.ts';

const roots: string[] = [];
const now = new Date('2026-09-29T00:00:00.000Z');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-metrics-979-')); roots.push(root);
  const db = await openDatabase({ stateDir: root });
  for (const id of ['a', 'b']) db.sqlite.run("insert into projects(id,name,cwd,created_at,updated_at) values (?,?,?,?,?)", [id, id, `/tmp/${id}`, now.toISOString(), now.toISOString()]);
  return db;
}
function work(db: RunnerDatabase, id: number, project = 'a', ended = '2026-09-28T01:00:00Z') {
  db.sqlite.run("insert into issues(id,project_id,title,status,created_at,updated_at) values (?,?,?,'done',?,?)", [id, project, 'Fixture', now.toISOString(), now.toISOString()]);
  db.sqlite.run("insert into issue_runs(id,issue_id,attempt,status,started_at,ended_at) values (?,?,1,'succeeded','2026-09-28T00:00:00Z',?)", [`run-${id}`, id, ended]);
}
function event(db: RunnerDatabase, id: number, type: string, payload: unknown) {
  db.sqlite.run('insert into issue_events(issue_id,type,payload,created_at) values (?,?,?,?)', [id, type, JSON.stringify(payload), now.toISOString()]);
}

test('filters and paginates stable Work samples; groups and trends describe only the returned page', async () => {
  const db = await fixture();
  try {
    work(db, 1); work(db, 2, 'b'); work(db, 3); work(db, 4, 'a', '2026-08-01T00:00:00Z');
    const first = buildDeliveryEffectiveness(db, now, { project_id: 'a', limit: 1 });
    expect(first.samples.map(x => x.issue_id)).toEqual([3]);
    expect(first).toMatchObject({ has_more: true, next_before_issue_id: 3, aggregation_scope: 'page' });
    const second = buildDeliveryEffectiveness(db, now, { project_id: 'a', limit: 1, before_issue_id: first.next_before_issue_id! });
    expect(second.samples.map(x => x.issue_id)).toEqual([1]);
    expect(second.by_project[0]).toMatchObject({ key: 'a', sampled_works: 1 });
    expect(second.by_type[0].key).toBe('engineering_task');
    expect(second.trend[0].key).toBe('2026-09-28');
    expect(second.samples[0].run_ids).toEqual(['xw:run:issue_runs:run-1']);
  } finally { db.close(); }
});

test('separates missing costs, currency conflict, recorded help, injection and self-reported reuse', async () => {
  const db = await fixture();
  try {
    work(db, 1); work(db, 2); work(db, 3);
    db.sqlite.run("update run_attempts set cost_json=? where issue_run_id='run-1'", [JSON.stringify({ money: { currency: 'USD', amount_micros: 0 } })]);
    db.sqlite.run("insert into issue_runs(id,issue_id,attempt,status,started_at,ended_at) values ('run-1b',1,2,'succeeded','2026-09-28T02:00:00Z','2026-09-28T03:00:00Z')");
    db.sqlite.run("update run_attempts set cost_json=? where issue_run_id='run-1b'", [JSON.stringify({ money: { currency: 'CNY', amount_micros: 5 } })]);
    event(db, 1, 'issue.run_memory_injected.v1', { issue_run_id: 'run-1', prompt_section_token_estimate: 42, prompt_section_bytes: 100 });
    event(db, 1, 'issue.run_memory_cited.v1', { issue_run_id: 'run-1', id: 'memory:one' });
    event(db, 1, 'issue.memory_reflection_attempt.v1', { issue_run_id: 'run-1b', elapsed_ms: 123, usage: { model_calls: 2, completed_calls: 1, cost_usd: 0.1, completeness: 'partial' } });
    const result = buildDeliveryEffectiveness(db, now);
    const sample = result.samples.find(x => x.issue_id === 1)!;
    expect(sample.cost).toMatchObject({ status: 'unknown', reason: 'currency_conflict' });
    expect(sample.waiting.run_gap_ms).toBe(3600000);
    expect(result.intervention.unattended_works).toBeNull();
    expect(result.memory).toMatchObject({ injected_works: 1, cited_works: 1, injection_estimated_token_count: 42, evidence_supported_reuse: null });
    expect(result.supervisor).toMatchObject({ total_cost: null, reflection: { known_cost_usd: 0.1, partial_attempts: 1 } });
    expect(sample.audit_refs.some(x => x.startsWith('issue_event:'))).toBe(true);
    expect(result.cost).toMatchObject({ known_works: 0, unknown_works: 3 });
  } finally { db.close(); }
});

test('empty data stays unknown and candidate scanning is bounded even outside the date window', async () => {
  const db = await fixture();
  try {
    expect(buildDeliveryEffectiveness(db, now).memory.evidence_supported_reuse).toBeNull();
    db.sqlite.transaction(() => { for (let id = 1; id <= 510; id++) work(db, id, 'a', '2025-01-01T00:00:00Z'); })();
    const result = buildDeliveryEffectiveness(db, now);
    expect(result.sampled_works).toBe(0);
    expect(result.has_more).toBe(true);
    expect(result.query_budget.scanned_candidates).toBeLessThanOrEqual(500);
    expect(result.next_before_issue_id).toBeGreaterThan(0);
  } finally { db.close(); }
});

test('keeps zero and currencies separate, rejects incomplete attempts and oversized source data', async () => {
  const db = await fixture();
  try {
    work(db, 1); work(db, 2); work(db, 3);
    for (const [id, currency, amount] of [[1, 'USD', 0], [2, 'CNY', 1000000], [3, 'USD', 99]] as const) {
      db.sqlite.run('update run_attempts set cost_json=? where issue_run_id=?', [JSON.stringify({ money: { currency, amount_micros: amount } }), `run-${id}`]);
    }
    db.sqlite.run("delete from run_attempts where issue_run_id='run-3'");
    event(db, 3, 'issue.run_memory_snapshot.v1', { memory: { retrieval: { elapsed_ms: 5 } }, private_prompt: 'secret'.repeat(10000) });
    const data = buildDeliveryEffectiveness(db, now);
    expect(data.cost).toMatchObject({ known_works: 2, unknown_works: 1 });
    expect(data.cost.by_currency).toContainEqual({ currency: 'USD', amount_micros: 0, mean_micros: 0, works: 1 });
    expect(data.cost.by_currency).toContainEqual({ currency: 'CNY', amount_micros: 1000000, mean_micros: 1000000, works: 1 });
    expect(data.samples[0].limited_sources).toContain('invalid_or_oversized_events');
    expect(data.samples[0].memory.retrieval_elapsed_ms).toBeNull();
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data.samples[0].cost.status).toBe('unknown');
    db.sqlite.run("update issues set status='failed' where id=2");
    const failedCost = buildDeliveryEffectiveness(db, now);
    expect(failedCost.cost.by_currency.some(c => c.currency === 'CNY')).toBe(false);
    expect(failedCost.execution_cost.by_currency.some(c => c.currency === 'CNY' && c.amount_micros === 1000000)).toBe(true);
  } finally { db.close(); }
});

test('bounded source reads expose truncation and unresolved approvals never turn into zero wait', async () => {
  const db = await fixture();
  try {
    work(db, 1);
    db.sqlite.run("insert into pi_approval_requests(approval_id,issue_id,created_at,updated_at) values ('pending',1,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')");
    for (let i = 0; i < 70; i++) event(db, 1, 'issue.run_memory_injected.v1', { issue_run_id: 'run-1', prompt_section_token_estimate: 1 });
    const sample = buildDeliveryEffectiveness(db, now).samples[0];
    expect(sample.asked_for_help).toBe(true);
    expect(sample.waiting).toMatchObject({ approval_recorded_ms: null, approval_unknown_records: 1, total_wait_ms: null });
    expect(sample.limited_sources).toContain('issue.run_memory_injected.v1');
    expect(sample.memory.audit_events).toBe(64);
    expect(sample.audit_refs).toContain('pi_approval_requests:pending');
    const plan = db.sqlite.query<{ detail: string }, []>("explain query plan select id from issue_events where issue_id=1 and type='issue.run_memory_injected.v1' order by id desc limit 65").all();
    expect(plan.some(row => row.detail.includes('idx_issue_events_issue_type'))).toBe(true);
  } finally { db.close(); }
});

test('HTTP aggregation yields to timers under a full page and stays within a finite read budget', async () => {
  const { buildDeliveryEffectivenessAsync } = await import('./deliveryEffectiveness.ts');
  const db = await fixture();
  try {
    db.sqlite.transaction(() => { for (let id = 1; id <= 120; id++) work(db, id); })();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const started = performance.now();
    const data = await buildDeliveryEffectivenessAsync(db, now, { limit: 100 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(data.samples.length).toBeLessThanOrEqual(100);
    expect(data.has_more).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally { db.close(); }
});
