import type { RunnerDatabase } from "../db/database.ts";
import { getStoredEvidence } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";

type WorkSample = {
  id: number; status: string; last_run_id: string; started_at: string; ended_at: string;
  asked_for_help: number; recoveries: number; no_progress: number;
};
type CostSample = { issue_id: number; cost_json: string };
const SAMPLE_LIMIT = 100;

/** 有界只读统计：只消费执行账本、恢复/求助记录及结构化交付事件。 */
export function buildDeliveryEffectiveness(db: RunnerDatabase, now: Date) {
  const until = now.toISOString();
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const rows = db.sqlite.query<WorkSample, [string, string, number]>(`
    with finished as (
      select issue.id, issue.status, min(nullif(run.started_at, '')) as started_at,
        max(nullif(run.ended_at, '')) as ended_at
      from issues issue join issue_runs run on run.issue_id=issue.id
      where issue.status in ('done','failed','cancelled')
      group by issue.id
      having julianday(max(nullif(run.ended_at, ''))) between julianday(?) and julianday(?)
      order by ended_at desc, issue.id desc limit ?
    )
    select finished.*,
      (select r.run_id from issue_runs r where r.issue_id=finished.id order by r.attempt desc limit 1) as last_run_id,
      (exists(select 1 from pi_approval_requests a where a.issue_id=finished.id)
        or exists(select 1 from pi_notification_intents n where n.issue_id=finished.id and n.requires_user=1)) as asked_for_help,
      (select count(*) from pi_recovery_attempts r where r.issue_id=finished.id
        and r.status in ('progress','no_progress','failed')) as recoveries,
      (select count(*) from pi_recovery_attempts r where r.issue_id=finished.id and r.status='no_progress') as no_progress
    from finished
  `).all(since, until, SAMPLE_LIMIT + 1);
  const works = rows.slice(0, SAMPLE_LIMIT);
  const delivered = new Set<number>();
  for (const work of works) {
    if (work.status !== "done") continue;
    const latest = listStoredHandoffs(db, { limit: 1, work_id: `xw:work:issues:${work.id}` }).items[0]?.handoff;
    if (latest && latest.run_ids.includes(work.last_run_id as typeof latest.run_ids[number]) && ["ready", "delivered"].includes(latest.status) && latest.evidence_ids.length > 0
      && latest.delivery_actions.every(action => !action.required || action.outcome === "succeeded")
      && latest.evidence_ids.every(id => {
        const record = getStoredEvidence(db, id)?.evidence;
        return record?.status === "passed" && record.work_id === latest.work_id;
      })) delivered.add(work.id);
  }
  const completed = works.filter(work => work.status === "done");
  const recovered = works.filter(work => work.recoveries > 0);
  const durations = completed.map(work => Date.parse(work.ended_at) - Date.parse(work.started_at))
    .filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const costRows = completed.length ? db.sqlite.query<CostSample, number[]>(`
    select run.issue_id, coalesce(attempt.cost_json, '') as cost_json from issue_runs run
    left join run_attempts attempt on run.run_id=attempt.run_id
    where run.issue_id in (${completed.map(() => "?").join(",")})
  `).all(...completed.map(work => work.id)) : [];
  const costs = completed.map(work => completeWorkCost(costRows.filter(row => row.issue_id === work.id)));
  const currencies = new Map<string, { currency: string; amount_micros: number; works: number }>();
  for (const cost of costs) {
    if (!cost) continue;
    const value = currencies.get(cost.currency) || { currency: cost.currency, amount_micros: 0, works: 0 };
    value.amount_micros += cost.amount_micros;
    value.works += 1;
    currencies.set(cost.currency, value);
  }
  const withoutHelp = works.filter(work => delivered.has(work.id) && !work.asked_for_help).length;
  return {
    generated_at: until, since, sample_limit: SAMPLE_LIMIT, truncated: rows.length > SAMPLE_LIMIT,
    sampled_works: works.length, completed_works: completed.length, delivered_works: delivered.size,
    delivery_rate: rate(delivered.size, works.length),
    without_help_delivery_rate: rate(withoutHelp, works.length),
    without_help_delivered_works: withoutHelp,
    help_requested_works: works.filter(work => work.asked_for_help).length,
    recovery: {
      works: recovered.length, delivered_works: recovered.filter(work => delivered.has(work.id)).length,
      delivery_rate: rate(recovered.filter(work => delivered.has(work.id)).length, recovered.length),
      no_progress_attempts: works.reduce((sum, work) => sum + work.no_progress, 0),
      repeated_no_progress_works: works.filter(work => work.no_progress >= 2).length,
    },
    duration: { known_works: durations.length, median_ms: median(durations) },
    cost: {
      known_works: costs.filter(Boolean).length, unknown_works: costs.filter(cost => !cost).length,
      by_currency: [...currencies.values()].map(value => ({ ...value, mean_micros: value.amount_micros / value.works })),
    },
    coverage: {
      cohort: "latest ended run in last 30 days; terminal Work only; elapsed time from first run to last ended run",
      delivery: "done Work with latest ready/delivered Handoff, linked Evidence and no unfinished required delivery action",
      help: "recorded approval requests or requires_user notification intents; absence does not prove no manual intervention",
      cost: "executor provider-reported money only; all attempts required; Supervisor cost excluded; currencies kept separate",
    },
  };
}

function completeWorkCost(rows: CostSample[]): { currency: string; amount_micros: number } | null {
  if (!rows.length) return null;
  let currency = "";
  let amount = 0;
  for (const row of rows) {
    let money;
    try { money = JSON.parse(row.cost_json)?.money; } catch { return null; }
    if (!money || typeof money.amount_micros !== "number" || !Number.isFinite(money.amount_micros)
      || money.amount_micros < 0 || typeof money.currency !== "string" || !money.currency.trim()
      || money.currency === "unknown" || (currency && currency !== money.currency)) return null;
    currency = money.currency;
    amount += money.amount_micros;
  }
  return { currency, amount_micros: amount };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const index = Math.floor(values.length / 2);
  return values.length % 2 ? values[index] : (values[index - 1] + values[index]) / 2;
}
