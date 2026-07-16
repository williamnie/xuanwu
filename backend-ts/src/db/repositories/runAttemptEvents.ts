import type { RunnerDatabase } from "../database.ts";
import type { NormalizedRunEvent } from "../../providers/types.ts";
import { emptyRunCost, type CostUsage, type RunCost } from "../../domain/run/contracts.ts";
import { issueTimestamp } from "./issueCreate.ts";

type AttemptRow = { attempt_id: string; kind: string };
type Baseline = { cost: RunCost; source_ref: string };

export function projectNormalizedRunEvent(
  db: RunnerDatabase,
  issueRunID: string,
  event: NormalizedRunEvent | undefined,
  issueEventID: number
): void {
  if (!event?.cost || issueRunID.trim() === "") return;
  const attempt = latestAttempt(db, issueRunID);
  if (!attempt) return;
  const scopedCost = event.metadata.usage_scope === "provider_session_total" && attempt.kind !== "initial"
    ? providerSessionDelta(db, attempt.attempt_id, event.cost)
    : event.cost;
  const sourceRefs = [...new Set([
    ...scopedCost.source_refs.map((value) => value.trim()).filter(Boolean),
    `issue_events:${issueEventID}`
  ])];
  const cost = { ...scopedCost, source_refs: sourceRefs };
  db.sqlite.run(
    "update run_attempts set cost_json=?, revision=revision+1, updated_at=? where attempt_id=?",
    [JSON.stringify(cost), issueTimestamp(), attempt.attempt_id]
  );
}

function latestAttempt(db: RunnerDatabase, issueRunID: string): AttemptRow | null {
  return db.sqlite.query<AttemptRow, [string]>(`
    select attempt_id, kind from run_attempts
    where issue_run_id=?
    order by sequence desc
    limit 1
  `).get(issueRunID);
}

function providerSessionDelta(db: RunnerDatabase, attemptID: string, total: RunCost): RunCost {
  const baseline = usageBaseline(db, attemptID);
  if (!baseline) return {
    ...emptyRunCost(),
    source_refs: [...total.source_refs, `run-lifecycle-baseline:unavailable:${attemptID}`]
  };
  return {
    money: moneyDelta(total, baseline.cost),
    pricing_refs: [...new Set([...baseline.cost.pricing_refs, ...total.pricing_refs])],
    source_refs: [...new Set([...total.source_refs, baseline.source_ref])],
    usage: usageDelta(total.usage, baseline.cost.usage)
  };
}

function usageBaseline(db: RunnerDatabase, attemptID: string): Baseline | null {
  const row = db.sqlite.query<{ id: number; payload: string }, [string, string]>(`
    select id, payload from issue_events
    where type=? and json_valid(payload) and json_extract(payload, '$.attempt_id')=?
    order by id desc limit 1
  `).get("run.lifecycle.intent.v1", attemptID);
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const baseline = objectValue(payload.provider_usage_baseline);
    const cost = objectValue(baseline.cost) as RunCost;
    if (!cost.usage || !cost.money || !Array.isArray(cost.source_refs) || !Array.isArray(cost.pricing_refs)) return null;
    return { cost, source_ref: `issue_events:${row.id}` };
  } catch {
    return null;
  }
}

function usageDelta(total: CostUsage, baseline: CostUsage): CostUsage {
  const usage = {
    cached_input_tokens: tokenDelta(total.cached_input_tokens, baseline.cached_input_tokens),
    input_tokens: tokenDelta(total.input_tokens, baseline.input_tokens),
    output_tokens: tokenDelta(total.output_tokens, baseline.output_tokens),
    reasoning_output_tokens: tokenDelta(total.reasoning_output_tokens, baseline.reasoning_output_tokens),
    total_tokens: tokenDelta(total.total_tokens, baseline.total_tokens)
  };
  if (usage.cached_input_tokens !== null && usage.input_tokens !== null && usage.cached_input_tokens > usage.input_tokens) {
    usage.cached_input_tokens = null;
  }
  if (usage.reasoning_output_tokens !== null && usage.output_tokens !== null &&
      usage.reasoning_output_tokens > usage.output_tokens) {
    usage.reasoning_output_tokens = null;
  }
  if (usage.total_tokens !== null && usage.input_tokens !== null && usage.output_tokens !== null &&
      usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    usage.total_tokens = null;
  }
  const values = Object.values(usage);
  const completeness = values.every((value) => value === null)
    ? "unavailable"
    : values.every((value) => value !== null) ? "complete" : "partial";
  return { ...usage, completeness };
}

function moneyDelta(total: RunCost, baseline: RunCost): RunCost["money"] {
  const current = total.money;
  const before = baseline.money;
  if (current.amount_micros === null || before.amount_micros === null ||
      current.currency === "" || current.currency !== before.currency ||
      current.amount_micros < before.amount_micros) return emptyRunCost().money;
  return { ...current, amount_micros: current.amount_micros - before.amount_micros };
}

function tokenDelta(total: number | null, baseline: number | null): number | null {
  if (total === null || baseline === null || total < baseline) return null;
  return total - baseline;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
