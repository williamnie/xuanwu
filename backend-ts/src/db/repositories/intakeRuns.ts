import type { RunnerDatabase } from "../database.ts";
import {
  cleanString,
  confidence,
  integerValue,
  jsonArray,
  jsonObject,
  jsonText,
  lastInsertID,
  objectArray,
  objectValue,
  positiveInteger,
  requiredString,
  requiredStringList,
  runStatus,
  stringList,
  type JsonObject
} from "./intakeRunSupport.ts";

type SQLValue = number | string;

export type IntakeRunStatus = "running" | "succeeded" | "failed";

export type IntakeRunInput = {
  bundle_id: number;
  error?: string;
  ignored_groups?: JsonObject[];
  input_summary?: JsonObject;
  model?: string;
  model_policy_id?: string;
  schema_output?: JsonObject;
  skill_id: string;
  status?: IntakeRunStatus;
};

export type IntakeRunRecord = Required<IntakeRunInput> & {
  created_at: string;
  error: string;
  id: number;
  ignored_groups_json: string;
  input_summary_json: string;
  schema_output_json: string;
  updated_at: string;
};

export type IntakeRunPatch = Partial<Omit<IntakeRunInput, "bundle_id" | "skill_id">>;

export type AttentionInboxItemInput = {
  actor_refs?: string[];
  bundle_id: number;
  confidence: number;
  evidence_refs: string[];
  intake_run_id: number;
  primary_intent: string;
  schema_item?: JsonObject;
  secondary_intents?: string[];
  source: string;
  status?: string;
  suggested_actions: string[];
  summary: string;
  target_hints?: JsonObject[];
  title: string;
  urgency?: string;
};

export type AttentionInboxItemRecord = Required<AttentionInboxItemInput> & {
  actor_refs_json: string;
  created_at: string;
  evidence_refs_json: string;
  id: number;
  kind: "attention";
  schema_item_json: string;
  secondary_intents_json: string;
  suggested_actions_json: string;
  target_hints_json: string;
  updated_at: string;
};

export type AttentionInboxItemFilter = { intakeRunId?: number; status?: string };

const RUN_COLUMNS = `id, bundle_id, skill_id, model_policy_id, model,
  input_summary_json, schema_output_json, ignored_groups_json, error, status,
  created_at, updated_at`;
const ITEM_COLUMNS = `id, source, bundle_id, intake_run_id, title, summary, kind,
  primary_intent, secondary_intents_json, suggested_actions_json, confidence,
  urgency, evidence_refs_json, actor_refs_json, target_hints_json,
  schema_item_json, status, created_at, updated_at`;

export function createIntakeRun(
  db: RunnerDatabase,
  input: IntakeRunInput,
  timestamp = new Date()
): IntakeRunRecord {
  const record = normalizeRun(input, timestamp);
  db.sqlite.run(`insert into intake_runs (${runInsertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, runInsertValues(record));
  const saved = getIntakeRun(db, lastInsertID(db));
  if (!saved) throw new Error("intake run missing after write");
  return saved;
}

export function updateIntakeRun(
  db: RunnerDatabase,
  id: number,
  patch: IntakeRunPatch,
  timestamp = new Date()
): IntakeRunRecord {
  const current = requireIntakeRun(db, id);
  const next = normalizeRun({ ...current, ...patch }, new Date(current.created_at));
  db.sqlite.run(`update intake_runs set model_policy_id=?, model=?,
    input_summary_json=?, schema_output_json=?, ignored_groups_json=?,
    error=?, status=?, updated_at=? where id=?`, [
    next.model_policy_id, next.model, next.input_summary_json,
    next.schema_output_json, next.ignored_groups_json, next.error,
    next.status, timestamp.toISOString(), id
  ]);
  return requireIntakeRun(db, id);
}

export function getIntakeRun(db: RunnerDatabase, id: number): IntakeRunRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${RUN_COLUMNS} from intake_runs where id=?`
  ).get(id);
  return row ? mapRun(row) : null;
}

export function createAttentionInboxItem(
  db: RunnerDatabase,
  input: AttentionInboxItemInput,
  timestamp = new Date()
): AttentionInboxItemRecord {
  const record = normalizeItem(input, timestamp);
  db.sqlite.run(`insert into attention_inbox_items (${itemInsertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, itemValues(record));
  const saved = getAttentionInboxItem(db, lastInsertID(db));
  if (!saved) throw new Error("attention inbox item missing after write");
  return saved;
}

export function listAttentionInboxItems(
  db: RunnerDatabase,
  filter: AttentionInboxItemFilter = {}
): AttentionInboxItemRecord[] {
  const query = itemListQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${ITEM_COLUMNS} from attention_inbox_items${query.where}
      order by created_at desc, id desc limit ?`
  ).all(...query.args).map(mapItem);
}

function getAttentionInboxItem(db: RunnerDatabase, id: number): AttentionInboxItemRecord | null {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${ITEM_COLUMNS} from attention_inbox_items where id=?`
  ).get(id);
  return row ? mapItem(row) : null;
}

function normalizeRun(input: IntakeRunInput, timestamp: Date): IntakeRunRecord {
  const bundleID = positiveInteger(input.bundle_id, "bundle_id");
  const skillID = requiredString(input.skill_id, "skill_id");
  const ignored = objectArray(input.ignored_groups);
  const output = objectValue(input.schema_output);
  return {
    id: 0, bundle_id: bundleID, skill_id: skillID,
    model_policy_id: cleanString(input.model_policy_id), model: cleanString(input.model),
    input_summary: objectValue(input.input_summary), schema_output: output,
    ignored_groups: ignored, error: cleanString(input.error),
    status: runStatus(input.status), input_summary_json: JSON.stringify(objectValue(input.input_summary)),
    schema_output_json: JSON.stringify(output), ignored_groups_json: JSON.stringify(ignored),
    created_at: timestamp.toISOString(), updated_at: timestamp.toISOString()
  };
}

function normalizeItem(input: AttentionInboxItemInput, timestamp: Date): AttentionInboxItemRecord {
  const schemaItem = objectValue(input.schema_item);
  return {
    id: 0, source: requiredString(input.source, "source"),
    bundle_id: positiveInteger(input.bundle_id, "bundle_id"),
    intake_run_id: positiveInteger(input.intake_run_id, "intake_run_id"),
    title: requiredString(input.title, "title"), summary: requiredString(input.summary, "summary"),
    kind: "attention", primary_intent: requiredString(input.primary_intent, "primary_intent"),
    secondary_intents: stringList(input.secondary_intents), suggested_actions: stringList(input.suggested_actions),
    confidence: confidence(input.confidence), urgency: cleanString(input.urgency),
    evidence_refs: requiredStringList(input.evidence_refs, "evidence_refs"),
    actor_refs: stringList(input.actor_refs), target_hints: objectArray(input.target_hints),
    schema_item: schemaItem, status: cleanString(input.status) || "new",
    secondary_intents_json: JSON.stringify(stringList(input.secondary_intents)),
    suggested_actions_json: JSON.stringify(stringList(input.suggested_actions)),
    evidence_refs_json: JSON.stringify(requiredStringList(input.evidence_refs, "evidence_refs")),
    actor_refs_json: JSON.stringify(stringList(input.actor_refs)),
    target_hints_json: JSON.stringify(objectArray(input.target_hints)),
    schema_item_json: JSON.stringify(schemaItem),
    created_at: timestamp.toISOString(), updated_at: timestamp.toISOString()
  };
}

function mapRun(row: Record<string, unknown>): IntakeRunRecord {
  return {
    id: integerValue(row.id, "intake_runs.id"),
    bundle_id: integerValue(row.bundle_id, "intake_runs.bundle_id"),
    skill_id: requiredString(row.skill_id, "intake_runs.skill_id"),
    model_policy_id: cleanString(row.model_policy_id), model: cleanString(row.model),
    input_summary: jsonObject(row.input_summary_json), schema_output: jsonObject(row.schema_output_json),
    ignored_groups: objectArray(jsonArray(row.ignored_groups_json)), error: cleanString(row.error),
    status: runStatus(row.status), input_summary_json: jsonText(row.input_summary_json, "{}"),
    schema_output_json: jsonText(row.schema_output_json, "{}"),
    ignored_groups_json: jsonText(row.ignored_groups_json, "[]"),
    created_at: requiredString(row.created_at, "intake_runs.created_at"),
    updated_at: requiredString(row.updated_at, "intake_runs.updated_at")
  };
}

function mapItem(row: Record<string, unknown>): AttentionInboxItemRecord {
  return {
    id: integerValue(row.id, "attention_inbox_items.id"), source: requiredString(row.source, "source"),
    bundle_id: integerValue(row.bundle_id, "bundle_id"),
    intake_run_id: integerValue(row.intake_run_id, "intake_run_id"),
    title: requiredString(row.title, "title"), summary: requiredString(row.summary, "summary"),
    kind: "attention", primary_intent: requiredString(row.primary_intent, "primary_intent"),
    secondary_intents: stringList(jsonArray(row.secondary_intents_json)),
    suggested_actions: stringList(jsonArray(row.suggested_actions_json)),
    confidence: confidence(row.confidence), urgency: cleanString(row.urgency),
    evidence_refs: stringList(jsonArray(row.evidence_refs_json)), actor_refs: stringList(jsonArray(row.actor_refs_json)),
    target_hints: objectArray(jsonArray(row.target_hints_json)), schema_item: jsonObject(row.schema_item_json),
    status: cleanString(row.status) || "new", secondary_intents_json: jsonText(row.secondary_intents_json, "[]"),
    suggested_actions_json: jsonText(row.suggested_actions_json, "[]"),
    evidence_refs_json: jsonText(row.evidence_refs_json, "[]"), actor_refs_json: jsonText(row.actor_refs_json, "[]"),
    target_hints_json: jsonText(row.target_hints_json, "[]"), schema_item_json: jsonText(row.schema_item_json, "{}"),
    created_at: requiredString(row.created_at, "created_at"), updated_at: requiredString(row.updated_at, "updated_at")
  };
}

function itemListQuery(filter: AttentionInboxItemFilter): { args: SQLValue[]; where: string } {
  const clauses: string[] = [];
  const args: SQLValue[] = [];
  if (filter.intakeRunId) addClause(clauses, args, "intake_run_id=?", filter.intakeRunId);
  if (cleanString(filter.status) !== "") addClause(clauses, args, "status=?", cleanString(filter.status));
  args.push(100);
  return { args, where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "" };
}

function runInsertColumns(): string {
  return `bundle_id, skill_id, model_policy_id, model, input_summary_json,
    schema_output_json, ignored_groups_json, error, status, created_at, updated_at`;
}

function itemInsertColumns(): string {
  return `source, bundle_id, intake_run_id, title, summary, kind, primary_intent,
    secondary_intents_json, suggested_actions_json, confidence, urgency,
    evidence_refs_json, actor_refs_json, target_hints_json, schema_item_json,
    status, created_at, updated_at`;
}

function runInsertValues(record: IntakeRunRecord): SQLValue[] {
  return [record.bundle_id, record.skill_id, record.model_policy_id, record.model,
    record.input_summary_json, record.schema_output_json, record.ignored_groups_json,
    record.error, record.status, record.created_at, record.updated_at];
}

function itemValues(record: AttentionInboxItemRecord): SQLValue[] {
  return [record.source, record.bundle_id, record.intake_run_id, record.title, record.summary,
    record.kind, record.primary_intent, record.secondary_intents_json, record.suggested_actions_json,
    record.confidence, record.urgency, record.evidence_refs_json, record.actor_refs_json,
    record.target_hints_json, record.schema_item_json, record.status, record.created_at, record.updated_at];
}

function requireIntakeRun(db: RunnerDatabase, id: number): IntakeRunRecord {
  const run = getIntakeRun(db, id);
  if (!run) throw new Error(`intake run not found: ${id}`);
  return run;
}

function addClause(clauses: string[], args: SQLValue[], clause: string, value: SQLValue): void {
  clauses.push(clause);
  args.push(value);
}
