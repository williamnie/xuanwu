import type { RunnerDatabase } from "../db/database.ts";
import { dayKey, isoWeekKey, monthKey, zeroUsage } from "./helpers.ts";
import type { TokenUsage } from "./types.ts";

type ProviderUsageRow = {
  captured_at: string;
  cost_json: string;
  project_id: string;
  project_name: string;
};

type MoneySummary = {
  amount_micros: number | null;
  completeness: "available" | "unavailable";
  currency: string;
};

type UsageAccumulator = {
  known_usage_rows: number;
  money: Map<string, number>;
  usage: TokenUsage;
};

export function readRunnerProviderUsage(
  database: RunnerDatabase,
  providerID: string,
  now = new Date()
): Record<string, unknown> {
  const provider = clean(providerID);
  if (provider === "") throw new Error("provider 不能为空");
  const rows = database.sqlite.query<ProviderUsageRow, [string]>(`
    select attempt.cost_json,
      coalesce(nullif(attempt.ended_at, ''), nullif(attempt.updated_at, ''),
        nullif(attempt.started_at, ''), attempt.created_at) as captured_at,
      issue.project_id,
      coalesce(project.name, issue.project_id) as project_name
    from run_attempts attempt
    join issue_runs run on run.id=attempt.issue_run_id
    join issues issue on issue.id=run.issue_id
    left join projects project on project.id=issue.project_id
    where attempt.provider=?
  `).all(provider);
  const summary = {
    all_time: accumulator(),
    this_month: accumulator(),
    this_week: accumulator(),
    today: accumulator()
  };
  const projects = new Map<string, { name: string; value: UsageAccumulator }>();
  let recordsScanned = 0;
  for (const row of rows) {
    const cost = providerCost(row.cost_json);
    if (!cost) continue;
    recordsScanned += 1;
    addCost(summary.all_time, cost);
    const capturedAt = new Date(row.captured_at);
    if (!Number.isNaN(capturedAt.getTime())) {
      if (monthKey(capturedAt) === monthKey(now)) addCost(summary.this_month, cost);
      if (isoWeekKey(capturedAt) === isoWeekKey(now)) addCost(summary.this_week, cost);
      if (dayKey(capturedAt) === dayKey(now)) addCost(summary.today, cost);
    }
    const project = projects.get(row.project_id) ?? { name: row.project_name, value: accumulator() };
    addCost(project.value, cost);
    projects.set(row.project_id, project);
  }
  const allTimeTokens = summary.all_time.usage.total_tokens;
  return {
    events_scanned: recordsScanned,
    generated_at: now.toISOString(),
    project_usage: [...projects.entries()]
      .map(([id, project]) => ({
        id,
        name: project.name,
        percent: allTimeTokens > 0 ? (project.value.usage.total_tokens / allTimeTokens) * 100 : 0,
        sessions: [],
        issues: [],
        usage: project.value.usage
      }))
      .sort((left, right) => right.usage.total_tokens - left.usage.total_tokens || left.id.localeCompare(right.id)),
    provider: { id: provider, scope: "runner_attempts" },
    rate_limits: null,
    source: "run_attempts.cost_json",
    summary: {
      all_time: finishAccumulator(summary.all_time),
      this_month: finishAccumulator(summary.this_month),
      this_week: finishAccumulator(summary.this_week),
      today: finishAccumulator(summary.today)
    }
  };
}

function providerCost(value: string): { money: MoneySummary; usage: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const usage = objectValue(parsed.usage);
    const money = objectValue(parsed.money);
    const amount = nonNegativeInteger(money.amount_micros);
    const currency = text(money.currency).toUpperCase();
    const hasUsage = USAGE_FIELDS.some((field) => nonNegativeInteger(usage[field]) !== null);
    const hasMoney = amount !== null && currency !== "";
    if (!hasUsage && !hasMoney) return null;
    return {
      money: {
        amount_micros: hasMoney ? amount : null,
        completeness: hasMoney ? "available" : "unavailable",
        currency: hasMoney ? currency : ""
      },
      usage
    };
  } catch {
    return null;
  }
}

const USAGE_FIELDS = [
  "cached_input_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
] as const;

function accumulator(): UsageAccumulator {
  return { known_usage_rows: 0, money: new Map(), usage: zeroUsage() };
}

function addCost(target: UsageAccumulator, cost: { money: MoneySummary; usage: Record<string, unknown> }): void {
  let usageKnown = false;
  for (const field of USAGE_FIELDS) {
    const value = nonNegativeInteger(cost.usage[field]);
    if (value === null) continue;
    target.usage[field] += value;
    usageKnown = true;
  }
  if (usageKnown) target.known_usage_rows += 1;
  if (cost.money.amount_micros !== null && cost.money.currency !== "") {
    target.money.set(cost.money.currency, (target.money.get(cost.money.currency) ?? 0) + cost.money.amount_micros);
  }
}

function finishAccumulator(value: UsageAccumulator): Record<string, unknown> {
  return {
    ...value.usage,
    completeness: value.known_usage_rows > 0 ? "available" : "unavailable",
    money: finishMoney(value.money)
  };
}

function finishMoney(values: Map<string, number>): MoneySummary {
  if (values.size !== 1) return { amount_micros: null, completeness: "unavailable", currency: "" };
  const [currency, amount] = [...values.entries()][0];
  return { amount_micros: amount, completeness: "available", currency };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: unknown): string {
  return text(value).slice(0, 64);
}
