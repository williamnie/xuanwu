import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";

export type PiNotificationPreference = {
  confirmation_text: string; conversation_id: string; created_at: string;
  digest_policy_json: string; effective_after_sequence: number; effective_after_time: string;
  expires_at: string; id: string; mode: string; notify_on_json: string;
  policy_kind: string; project_id: string; run_group_id: string; scope: string;
  source_event_id: string; source_event_sequence_id: number; source_message_id: string;
  status: string; updated_at: string; version: number;
};
export type PiNotificationPreferenceInput = PatchInput<PiNotificationPreference>;
export type PiNotificationPreferenceFilter = {
  conversationId?: string; projectId?: string; runGroupId?: string; scope?: string; status?: string;
};
export type ActivePiNotificationPreferenceFilter = PiNotificationPreferenceFilter & {
  eventSequence?: number; referenceTime?: string;
};

type SQLValue = string | number;
const TABLE = "pi_notification_preferences";
const COLUMNS = `id, project_id, conversation_id, run_group_id, scope,
  policy_kind, mode, notify_on_json, digest_policy_json, source_message_id,
  source_event_id, source_event_sequence_id, confirmation_text,
  effective_after_sequence, effective_after_time, version, status, expires_at,
  created_at, updated_at`;

export function createPiNotificationPreference(
  db: RunnerDatabase,
  input: PiNotificationPreferenceInput
): PiNotificationPreference {
  const existing = getPiNotificationPreference(db, cleanString(input.id));
  if (existing) return existing;
  let id = "";
  db.transaction(() => {
    const record = normalizeCreate(db, input);
    supersedeActivePreferenceScope(db, record);
    db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(20)})`, [
      record.id, record.project_id, record.conversation_id, record.run_group_id,
      record.scope, record.policy_kind, record.mode, record.notify_on_json,
      record.digest_policy_json, record.source_message_id, record.source_event_id,
      record.source_event_sequence_id, record.confirmation_text,
      record.effective_after_sequence, record.effective_after_time, record.version,
      record.status, record.expires_at, record.created_at, record.updated_at
    ]);
    id = record.id;
  }).immediate();
  return requirePiNotificationPreference(db, id);
}

export function getPiNotificationPreference(
  db: RunnerDatabase,
  id: string
): PiNotificationPreference | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(key);
  return row ? mapPreference(row) : null;
}

export function listPiNotificationPreferences(
  db: RunnerDatabase,
  filter: PiNotificationPreferenceFilter = {}
): PiNotificationPreference[] {
  return listRows(db, TABLE, COLUMNS, mapPreference, buildFilter([
    ["project_id=?", filter.projectId],
    ["conversation_id=?", filter.conversationId],
    ["run_group_id=?", filter.runGroupId],
    ["scope=?", filter.scope],
    ["status=?", filter.status]
  ], preferenceOrder()));
}

export function listActivePiNotificationPreferences(
  db: RunnerDatabase,
  filter: ActivePiNotificationPreferenceFilter = {}
): PiNotificationPreference[] {
  const conditions = ["status='active'", "(expires_at='' or expires_at>?)"];
  const args: SQLValue[] = [cleanString(filter.referenceTime) || now()];
  addOptionalFilter(conditions, args, "project_id", filter.projectId);
  addOptionalFilter(conditions, args, "conversation_id", filter.conversationId);
  addOptionalFilter(conditions, args, "run_group_id", filter.runGroupId);
  addOptionalFilter(conditions, args, "scope", filter.scope);
  if (filter.eventSequence !== undefined) {
    conditions.push("effective_after_sequence<?");
    args.push(integerInput(filter.eventSequence));
  }
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from ${TABLE} where ${conditions.join(" and ")} order by ${preferenceOrder()}`
  ).all(...args).map(mapPreference);
}

export function expirePiNotificationPreferences(db: RunnerDatabase, referenceTime = now()): number {
  const result = db.sqlite.run(
    `update ${TABLE} set status='expired', updated_at=? where status='active' and expires_at!='' and expires_at<=?`,
    [now(), cleanString(referenceTime)]
  );
  return result.changes;
}

export function disablePiNotificationPreference(
  db: RunnerDatabase,
  id: string
): PiNotificationPreference {
  updateStatus(db, id, "disabled");
  return requirePiNotificationPreference(db, id);
}

function normalizeCreate(db: RunnerDatabase, input: PiNotificationPreferenceInput): PiNotificationPreference {
  const timestamp = now();
  const scope = requiredString(input.scope, "scope");
  const mode = cleanString(input.mode) || "normal";
  return {
    confirmation_text: cleanString(input.confirmation_text),
    conversation_id: cleanString(input.conversation_id),
    created_at: timestamp,
    digest_policy_json: jsonPayload(input.digest_policy_json, "{}"),
    effective_after_sequence: effectiveSequence(db, input.effective_after_sequence),
    effective_after_time: cleanString(input.effective_after_time) || timestamp,
    expires_at: cleanString(input.expires_at),
    id: cleanString(input.id) || crypto.randomUUID(),
    mode,
    notify_on_json: jsonPayload(input.notify_on_json, "[]"),
    policy_kind: cleanString(input.policy_kind) || "user_preference",
    project_id: cleanString(input.project_id),
    run_group_id: cleanString(input.run_group_id),
    scope,
    source_event_id: cleanString(input.source_event_id),
    source_event_sequence_id: integerInput(input.source_event_sequence_id),
    source_message_id: cleanString(input.source_message_id),
    status: cleanString(input.status) || "active",
    updated_at: timestamp,
    version: nextVersion(db, input)
  };
}

function supersedeActivePreferenceScope(db: RunnerDatabase, record: PiNotificationPreference): void {
  if (record.status !== "active") return;
  db.sqlite.run(`update ${TABLE} set status='superseded', updated_at=?
    where status='active' and scope=? and project_id=? and conversation_id=? and run_group_id=?`, [
    now(), record.scope, record.project_id, record.conversation_id, record.run_group_id
  ]);
}

function updateStatus(db: RunnerDatabase, id: string, status: string): void {
  db.sqlite.run(`update ${TABLE} set status=?, updated_at=? where id=?`, [
    status, now(), requiredString(id, "id")
  ]);
}

function nextVersion(db: RunnerDatabase, input: PiNotificationPreferenceInput): number {
  const row = db.sqlite.query<{ version: number | null }, [string, string, string, string]>(
    `select max(version) as version from ${TABLE}
      where scope=? and project_id=? and conversation_id=? and run_group_id=?`
  ).get(
    cleanString(input.scope),
    cleanString(input.project_id),
    cleanString(input.conversation_id),
    cleanString(input.run_group_id)
  );
  return integerInput(row?.version, 0) + 1;
}

function effectiveSequence(db: RunnerDatabase, value: unknown): number {
  if (value !== undefined) return integerInput(value);
  const row = db.sqlite.query<{ sequence_id: number | null }, []>(
    "select max(sequence_id) as sequence_id from pi_guardian_event_inbox"
  ).get();
  return integerInput(row?.sequence_id);
}

function mapPreference(row: Record<string, unknown>): PiNotificationPreference {
  return {
    confirmation_text: optionalString(row.confirmation_text),
    conversation_id: optionalString(row.conversation_id),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    digest_policy_json: optionalString(row.digest_policy_json) || "{}",
    effective_after_sequence: integerValue(row.effective_after_sequence, "effective_after_sequence"),
    effective_after_time: optionalString(row.effective_after_time),
    expires_at: optionalString(row.expires_at),
    id: requiredString(row.id, `${TABLE}.id`),
    mode: requiredString(row.mode, `${TABLE}.mode`),
    notify_on_json: optionalString(row.notify_on_json) || "[]",
    policy_kind: requiredString(row.policy_kind, `${TABLE}.policy_kind`),
    project_id: optionalString(row.project_id),
    run_group_id: optionalString(row.run_group_id),
    scope: requiredString(row.scope, `${TABLE}.scope`),
    source_event_id: optionalString(row.source_event_id),
    source_event_sequence_id: integerValue(row.source_event_sequence_id, "source_event_sequence_id"),
    source_message_id: optionalString(row.source_message_id),
    status: requiredString(row.status, `${TABLE}.status`),
    updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`),
    version: integerValue(row.version, "version")
  };
}

function requirePiNotificationPreference(db: RunnerDatabase, id: string): PiNotificationPreference {
  const preference = getPiNotificationPreference(db, id);
  if (!preference) throw new Error(`PI notification preference ${cleanString(id)} not found`);
  return preference;
}

function addOptionalFilter(
  conditions: string[],
  args: SQLValue[],
  column: string,
  value: string | undefined
): void {
  const text = cleanString(value);
  if (text === "") return;
  conditions.push(`${column}=?`);
  args.push(text);
}

function preferenceOrder(): string {
  return `case scope
    when 'run_group' then 1 when 'conversation' then 2
    when 'project' then 3 when 'global' then 4 else 5 end,
    version desc, created_at desc, id asc`;
}

function jsonPayload(value: unknown, fallback: string): string {
  if (typeof value === "string") return jsonText(value, fallback);
  return JSON.stringify(value ?? JSON.parse(fallback));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
