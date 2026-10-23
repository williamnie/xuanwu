import type { RunnerDatabase } from "../database.ts";
import {
  cleanString,
  integerValue,
  jsonArray,
  jsonObject,
  jsonText,
  objectArray,
  objectValue,
  type JsonObject
} from "./intakeRunSupport.ts";
import {
  mapAutomationScheduleState,
  type PiAutomationScheduleState
} from "./piAutomationScheduleState.ts";

type AutomationTriggerType = "manual" | "schedule" | "continuous" | "webhook";
type AutomationStepType = "source_sync" | "context_bundle" | "intake" | "domain_skill";
type AutomationMode = "dry_run" | "draft" | "propose" | "auto";

type AutomationStep = JsonObject & {
  cursor: string;
  idempotency_key: string;
  skill_id: string;
  type: AutomationStepType;
  watermark: string;
};

type AutomationTrigger = JsonObject & { type: AutomationTriggerType };

type PiAutomationInput = {
  enabled?: boolean | number;
  filters?: JsonObject[];
  max_actions_per_run?: number;
  mode?: AutomationMode;
  name: string;
  next_run_at?: string;
  retry_backoff_seconds?: number;
  run_timeout_ms?: number;
  source_policy?: JsonObject;
  steps: JsonObject[];
  trigger?: JsonObject;
  trigger_type?: AutomationTriggerType;
};

export type PiAutomationRecord = Required<Omit<PiAutomationInput, "enabled" | "trigger_type">> & {
  created_at: string; enabled: boolean; filters_json: string; id: number;
  max_actions_per_run: number; source_policy_json: string; steps_json: string;
  trigger: AutomationTrigger; trigger_config_json: string;
  trigger_type: AutomationTriggerType; updated_at: string;
} & PiAutomationScheduleState;

const COLUMNS = `id, name, trigger_type, trigger_config_json, mode,
  filters_json, source_policy_json, max_actions_per_run, enabled,
  steps_json, created_at, updated_at, next_run_at, last_run_at, last_status,
  last_result, error, run_count, retry_count, retry_backoff_seconds, lock_token,
  lock_expires_at, run_started_at, run_timeout_ms, processed_watermark,
  last_successful_cursor, failed_cursor`;

export function getPiAutomation(db: RunnerDatabase, id: number): PiAutomationRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from pi_automations where id=?`
  ).get(id);
  return row ? mapAutomation(row) : null;
}

function mapAutomation(row: Record<string, unknown>): PiAutomationRecord {
  const trigger = normalizeTrigger(jsonObject(row.trigger_config_json), row.trigger_type);
  return {
    id: integerValue(row.id, "pi_automations.id"), name: requiredName(row.name),
    trigger, trigger_type: trigger.type, mode: normalizeMode(row.mode),
    filters: objectArray(jsonArray(row.filters_json)), source_policy: jsonObject(row.source_policy_json),
    max_actions_per_run: actionLimit(row.max_actions_per_run), enabled: row.enabled === 1,
    steps: normalizeSteps(jsonArray(row.steps_json)),
    trigger_config_json: jsonText(row.trigger_config_json, "{}"),
    filters_json: jsonText(row.filters_json, "[]"),
    source_policy_json: jsonText(row.source_policy_json, "{}"),
    steps_json: jsonText(row.steps_json, "[]"),
    created_at: requiredTimestamp(row.created_at, "created_at"),
    updated_at: requiredTimestamp(row.updated_at, "updated_at"),
    ...mapAutomationScheduleState(row)
  };
}

function normalizeTrigger(trigger: unknown, fallbackType: unknown): AutomationTrigger {
  const value = objectValue(trigger);
  const type = triggerType(value.type || fallbackType);
  return { ...value, type };
}

function normalizeSteps(value: unknown): AutomationStep[] {
  const steps = Array.isArray(value) ? value : [];
  const normalized = steps.map(normalizeStep).filter(Boolean) as AutomationStep[];
  if (normalized.length === 0) throw new Error("automation steps are required");
  return normalized;
}

function normalizeStep(value: unknown, index: number): AutomationStep | null {
  const step = objectValue(value);
  const type = stepType(step.type);
  if (!type) return null;
  return {
    ...step, type, skill_id: cleanString(step.skill_id || step.skillId),
    cursor: cleanString(step.cursor), watermark: cleanString(step.watermark),
    idempotency_key: cleanString(step.idempotency_key || step.idempotencyKey) || `step:${index}:${type}`
  };
}

function triggerType(value: unknown): AutomationTriggerType {
  const text = cleanString(value);
  if (text === "schedule" || text === "continuous" || text === "webhook") return text;
  return "manual";
}

function stepType(value: unknown): AutomationStepType | null {
  const text = cleanString(value);
  return ["source_sync", "context_bundle", "intake", "domain_skill"].includes(text)
    ? text as AutomationStepType
    : null;
}

function normalizeMode(value: unknown): AutomationMode {
  const text = cleanString(value);
  return ["dry_run", "draft", "propose", "auto"].includes(text) ? text as AutomationMode : "propose";
}

function actionLimit(value: unknown): number {
  if (typeof value !== "number") return 1;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : 1;
}

function requiredName(value: unknown): string {
  const name = cleanString(value);
  if (name === "") throw new Error("automation name is required");
  return name;
}

function requiredTimestamp(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`pi_automations.${label} is required`);
  return text;
}
