import type { RunnerDatabase } from "../database.ts";
import {
  cleanString,
  integerValue,
  jsonArray,
  jsonObject,
  jsonText,
  lastInsertID,
  objectArray,
  objectValue,
  positiveInteger,
  type JsonObject
} from "./intakeRunSupport.ts";
import {
  automationScheduleState,
  mapAutomationScheduleState,
  type PiAutomationScheduleState
} from "./piAutomationScheduleState.ts";

type SQLValue = number | string;

export type AutomationTriggerType = "manual" | "schedule" | "continuous" | "webhook";
export type AutomationStepType = "source_sync" | "context_bundle" | "intake" | "domain_skill";
export type AutomationMode = "dry_run" | "draft" | "propose" | "auto";

export type AutomationStep = JsonObject & {
  cursor: string;
  idempotency_key: string;
  skill_id: string;
  type: AutomationStepType;
  watermark: string;
};

export type AutomationTrigger = JsonObject & { type: AutomationTriggerType };

export type PiAutomationInput = {
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

export type PiAutomationPatch = Partial<PiAutomationInput>;
export type PiAutomationFilter = { enabled?: boolean; triggerType?: AutomationTriggerType };

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

export function createPiAutomation(
  db: RunnerDatabase,
  input: PiAutomationInput,
  timestamp = new Date()
): PiAutomationRecord {
  const record = normalizeAutomation(input, timestamp);
  db.sqlite.run(`insert into pi_automations (${insertColumns()})
    values (${insertValues(record).map(() => "?").join(", ")})`, insertValues(record));
  const saved = getPiAutomation(db, lastInsertID(db));
  if (!saved) throw new Error("pi automation missing after write");
  return saved;
}

export function updatePiAutomation(
  db: RunnerDatabase,
  id: number,
  patch: PiAutomationPatch,
  timestamp = new Date()
): PiAutomationRecord {
  const current = requirePiAutomation(db, id);
  const next = normalizeAutomation({ ...current, ...patch }, new Date(current.created_at));
  db.sqlite.run(`update pi_automations set name=?, trigger_type=?,
    trigger_config_json=?, mode=?, filters_json=?, source_policy_json=?,
    max_actions_per_run=?, enabled=?, steps_json=?, next_run_at=?,
    retry_backoff_seconds=?, run_timeout_ms=?, updated_at=? where id=?`, [
    next.name, next.trigger_type, next.trigger_config_json, next.mode,
    next.filters_json, next.source_policy_json, next.max_actions_per_run,
    next.enabled ? 1 : 0, next.steps_json, next.next_run_at,
    next.retry_backoff_seconds, next.run_timeout_ms, timestamp.toISOString(), id
  ]);
  return requirePiAutomation(db, id);
}

export function getPiAutomation(db: RunnerDatabase, id: number): PiAutomationRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from pi_automations where id=?`
  ).get(id);
  return row ? mapAutomation(row) : null;
}

export function listPiAutomations(
  db: RunnerDatabase,
  filter: PiAutomationFilter = {}
): PiAutomationRecord[] {
  const query = listQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from pi_automations${query.where}
      order by updated_at desc, id desc limit 500`
  ).all(...query.args).map(mapAutomation);
}

export function listRunnablePiAutomations(
  db: RunnerDatabase,
  triggerType?: AutomationTriggerType
): PiAutomationRecord[] {
  return listPiAutomations(db, { enabled: true, triggerType });
}

function normalizeAutomation(input: PiAutomationInput, timestamp: Date): PiAutomationRecord {
  const trigger = normalizeTrigger(input.trigger, input.trigger_type);
  const filters = objectArray(input.filters);
  const sourcePolicy = objectValue(input.source_policy);
  const steps = normalizeSteps(input.steps);
  const schedule = automationScheduleState(input, trigger, timestamp);
  return {
    id: 0, name: requiredName(input.name), trigger, trigger_type: trigger.type,
    mode: normalizeMode(input.mode), filters, source_policy: sourcePolicy,
    max_actions_per_run: actionLimit(input.max_actions_per_run), enabled: enabledFlag(input.enabled),
    steps, trigger_config_json: JSON.stringify(triggerConfig(trigger)),
    filters_json: JSON.stringify(filters), source_policy_json: JSON.stringify(sourcePolicy),
    steps_json: JSON.stringify(steps), created_at: timestamp.toISOString(),
    updated_at: timestamp.toISOString(), ...schedule
  };
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

function triggerConfig(trigger: AutomationTrigger): JsonObject {
  const { type: _type, ...config } = trigger;
  return config;
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

function listQuery(filter: PiAutomationFilter): { args: SQLValue[]; where: string } {
  const clauses: string[] = [];
  const args: SQLValue[] = [];
  if (filter.triggerType) addClause(clauses, args, "trigger_type=?", filter.triggerType);
  if (typeof filter.enabled === "boolean") addClause(clauses, args, "enabled=?", filter.enabled ? 1 : 0);
  return { args, where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "" };
}

function addClause(clauses: string[], args: SQLValue[], clause: string, value: SQLValue): void {
  clauses.push(clause);
  args.push(value);
}

function insertColumns(): string {
  return `name, trigger_type, trigger_config_json, mode, filters_json,
    source_policy_json, max_actions_per_run, enabled, steps_json,
    next_run_at, retry_backoff_seconds, run_timeout_ms, created_at, updated_at`;
}

function insertValues(record: PiAutomationRecord): SQLValue[] {
  return [record.name, record.trigger_type, record.trigger_config_json,
    record.mode, record.filters_json, record.source_policy_json,
    record.max_actions_per_run, record.enabled ? 1 : 0, record.steps_json,
    record.next_run_at, record.retry_backoff_seconds, record.run_timeout_ms,
    record.created_at, record.updated_at];
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

function enabledFlag(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  return typeof value === "number" ? value !== 0 : cleanString(value) !== "false";
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

function requirePiAutomation(db: RunnerDatabase, id: number): PiAutomationRecord {
  const automation = getPiAutomation(db, positiveInteger(id, "automation id"));
  if (!automation) throw new Error(`pi automation not found: ${id}`);
  return automation;
}
