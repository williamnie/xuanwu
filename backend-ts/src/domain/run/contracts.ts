import {
  RUN_STATUSES,
  type DomainActor,
  type RunID,
  type RunStatus,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";

export { RUN_STATUSES, type RunID, type RunStatus, type WorkID };

export const ATTEMPT_STATUSES = ["created", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];

const ATTEMPT_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;
export type AttemptTerminalStatus = typeof ATTEMPT_TERMINAL_STATUSES[number];

export const RUN_TRIGGERS = ["initial", "retry", "supersede"] as const;
export type RunTrigger = typeof RUN_TRIGGERS[number];

export const ATTEMPT_KINDS = ["initial", "resume", "recovery"] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];

export type RunAttemptID = `${RunID}~attempt:${number}`;

export type CostUsage = {
  cached_input_tokens: number | null;
  completeness: "unavailable" | "partial" | "complete";
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
};

type MonetaryCost = {
  amount_micros: number | null;
  basis: "unavailable" | "provider_reported" | "pricing_derived";
  currency: string;
};

export type RunCost = {
  money: MonetaryCost;
  pricing_refs: string[];
  source_refs: string[];
  usage: CostUsage;
};

export type ProviderAttemptRef = {
  // Provider refs are opaque facts. They never become Run identity or state authority.
  invocation_ref: string;
  observation_ref?: string;
  provider: string;
  session_ref?: string;
  turn_ref?: string;
};

type TerminalRecord = {
  reason: string;
  source_ref: string;
};

export type RunAttempt = {
  cost: RunCost;
  created_at: string;
  ended_at?: string;
  id: RunAttemptID;
  kind: AttemptKind;
  provider_ref: ProviderAttemptRef;
  revision: number;
  run_id: RunID;
  sequence: number;
  started_at?: string;
  status: AttemptStatus;
  terminal?: TerminalRecord;
  updated_at: string;
};

type RunTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type RunTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: RunTransitionGate;
  occurred_at: string;
  reason: string;
};

export function makeRunAttemptID(runID: RunID, sequence: number): RunAttemptID {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Attempt sequence must be positive");
  return `${runID}~attempt:${sequence}` as RunAttemptID;
}

export function emptyRunCost(): RunCost {
  return {
    money: { amount_micros: null, basis: "unavailable", currency: "" },
    pricing_refs: [],
    source_refs: [],
    usage: {
      cached_input_tokens: null,
      completeness: "unavailable",
      input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null
    }
  };
}

export function aggregateRunCost(attempts: readonly RunAttempt[]): RunCost {
  if (attempts.length === 0) return emptyRunCost();
  const costs = attempts.map((attempt) => attempt.cost);
  const usageFields = [
    "cached_input_tokens",
    "input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens"
  ] as const;
  const usageValues = Object.fromEntries(usageFields.map((field) => [field, sumKnown(costs.map((cost) => cost.usage[field]))])) as
    Pick<CostUsage, typeof usageFields[number]>;
  const anyUsage = usageFields.some((field) => usageValues[field] !== null);
  const usageCompleteness = !anyUsage
    ? "unavailable"
    : costs.every((cost) => cost.usage.completeness === "complete") ? "complete" : "partial";

  const allMoneyKnown = costs.every((cost) => cost.money.amount_micros !== null);
  const currencies = new Set(costs.map((cost) => cost.money.currency).filter(Boolean));
  const moneyKnown = allMoneyKnown && currencies.size === 1;
  const basis = !moneyKnown
    ? "unavailable"
    : costs.some((cost) => cost.money.basis === "pricing_derived") ? "pricing_derived" : "provider_reported";

  return {
    money: {
      amount_micros: moneyKnown ? costs.reduce((total, cost) => total + (cost.money.amount_micros ?? 0), 0) : null,
      basis,
      currency: moneyKnown ? [...currencies][0] ?? "" : ""
    },
    pricing_refs: uniqueStrings(costs.flatMap((cost) => cost.pricing_refs)),
    source_refs: uniqueStrings(costs.flatMap((cost) => cost.source_refs)),
    usage: { ...usageValues, completeness: usageCompleteness }
  };
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}
