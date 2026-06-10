import type { PiActionEnvelope, PiGateDecision, PiGatePolicy } from "./actionGate.ts";

type RecoveryGatePolicy = PiGatePolicy & {
  budgetRemaining?: number;
  budget_remaining?: number;
  cooldownUntil?: string;
  cooldown_until?: string;
};

const BUDGETED_ACTIONS = new Set([
  "issue.retry",
  "issue.retry_after",
  "session.resume_followup",
  "session.steer"
]);

export function recoveryLimitDecision(
  envelope: PiActionEnvelope,
  policy: PiGatePolicy
): PiGateDecision | undefined {
  if (!BUDGETED_ACTIONS.has(envelope.action_type)) return undefined;
  const recoveryPolicy = policy as RecoveryGatePolicy;
  const budget = numericPolicyValue(recoveryPolicy.budget_remaining ?? recoveryPolicy.budgetRemaining);
  if (budget !== undefined && budget <= 0) return { decision: "deny", reason: "recovery budget is exhausted" };
  const cooldownUntil = timeMs(recoveryPolicy.cooldown_until ?? recoveryPolicy.cooldownUntil);
  const nowMs = timeMs(policy.now ?? new Date()) ?? Date.now();
  if (cooldownUntil !== undefined && nowMs < cooldownUntil) {
    return { decision: "snooze", reason: "recovery cooldown has not elapsed" };
  }
  return undefined;
}

function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function numericPolicyValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
