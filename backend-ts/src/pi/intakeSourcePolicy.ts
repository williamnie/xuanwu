import type { RunnerDatabase } from "../db/database.ts";
import type { ContextBundleRecord, ContextBundleTrigger } from "../db/repositories/contextBundles.ts";

export type IntakeMode = "manual_only" | "mention_only" | "scheduled_llm_triage" | "continuous_llm_triage";

export type IntakeSourcePolicy = {
  automatic_intake_enabled?: boolean;
  frequency_limit_ms?: number;
  intake_mode?: IntakeMode;
  min_interval_ms?: number;
};

type LastRunRow = { created_at: string };

const AUTOMATIC_TRIGGERS: ContextBundleTrigger[] = ["mention", "schedule", "continuous", "webhook"];

export function assertIntakeSourcePolicy(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  policy: IntakeSourcePolicy | undefined,
  now = new Date()
): void {
  const reason = sourcePolicyBlockReason(db, bundle, policy, now);
  if (reason !== "") throw new Error(`intake blocked by source policy: ${reason}`);
}

export function sourcePolicyBlockReason(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  policy: IntakeSourcePolicy | undefined,
  now = new Date()
): string {
  if (isManualLike(bundle.trigger) || !policy) return "";
  if (policy.automatic_intake_enabled === false) return "automatic_intake_disabled";
  if (!triggerAllowed(intakeMode(policy.intake_mode), bundle.trigger)) return `trigger_${bundle.trigger}_not_allowed`;
  return frequencyBlockReason(db, bundle.source, frequencyLimit(policy), now);
}

function frequencyBlockReason(
  db: RunnerDatabase,
  source: string,
  limitMs: number,
  now: Date
): string {
  if (limitMs <= 0) return "";
  const last = latestAutomaticRunAt(db, source);
  if (!last) return "";
  const elapsed = now.getTime() - Date.parse(last);
  if (!Number.isFinite(elapsed) || elapsed >= limitMs) return "";
  return `frequency_limited_${Math.ceil((limitMs - elapsed) / 1000)}s`;
}

function latestAutomaticRunAt(db: RunnerDatabase, source: string): string {
  const row = db.sqlite.query<LastRunRow, [string]>(
    `select ir.created_at from intake_runs ir
      join context_bundles cb on cb.id=ir.bundle_id
      where cb.source=?
        and cb.trigger in ('mention', 'schedule', 'continuous', 'webhook')
        and ir.status in ('running', 'succeeded')
      order by ir.created_at desc, ir.id desc limit 1`
  ).get(source);
  return row?.created_at ?? "";
}

function triggerAllowed(mode: IntakeMode, trigger: ContextBundleTrigger): boolean {
  if (mode === "manual_only") return false;
  if (mode === "mention_only") return trigger === "mention";
  if (mode === "scheduled_llm_triage") return trigger === "mention" || trigger === "schedule";
  return AUTOMATIC_TRIGGERS.includes(trigger);
}

function isManualLike(trigger: ContextBundleTrigger): boolean {
  return trigger === "manual" || trigger === "retry";
}

function intakeMode(value: unknown): IntakeMode {
  return value === "manual_only" || value === "mention_only" || value === "scheduled_llm_triage"
    ? value
    : "continuous_llm_triage";
}

function frequencyLimit(policy: IntakeSourcePolicy): number {
  const value = policy.frequency_limit_ms ?? policy.min_interval_ms;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
