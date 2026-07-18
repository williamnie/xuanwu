import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

type LegacyDomainEvent = {
  action_id: string;
  conversation_id: string;
  error: string;
  heartbeat_id: string;
  id: number;
  issue_id: number;
  payload_json: string;
  project_id: string;
};

type AutomationRow = { id: number; steps_json: string };
type JsonObject = Record<string, unknown>;

const LEGACY_DOMAIN_SKILL_ID = "fixture-domain";
const LEGACY_DOMAIN_EVENT_TYPE = "attention_inbox.domain_skill_requested";
const MIGRATED_DOMAIN_SKILL_ID = "legacy-domain-proposal";
const DEFAULT_DOMAIN_SKILL_ID = "pi-domain-proposal";
const SKILL_RUNTIME_COMPLETED_EVENT = "skill_runtime.completed";

export const removeProductionFixturesMigration: SqlMigration = {
  id: "051_remove_production_fixtures",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    migrateAutomationSkillIDs(sqlite);
    migrateSkillMemoryScope(sqlite);
    migrateLegacyDomainRunEvents(sqlite);
  }
};

function migrateAutomationSkillIDs(sqlite: SQLiteDatabase): void {
  const rows = sqlite.query<AutomationRow, []>(
    "select id, steps_json from pi_automations where lower(steps_json) like '%fixture-domain%'"
  ).all();
  for (const row of rows) {
    const steps = parseArray(row.steps_json);
    let changed = false;
    const migrated = steps.map((value) => {
      const step = objectValue(value);
      if (cleanString(step.type) !== "domain_skill") return value;
      const key = Object.prototype.hasOwnProperty.call(step, "skill_id") ? "skill_id" : "skillId";
      if (normalizeID(step[key]) !== LEGACY_DOMAIN_SKILL_ID) return value;
      changed = true;
      return { ...step, [key]: DEFAULT_DOMAIN_SKILL_ID };
    });
    if (!changed) continue;
    sqlite.run(
      `update pi_automations set steps_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=?`,
      [JSON.stringify(migrated), row.id]
    );
  }
}

function migrateSkillMemoryScope(sqlite: SQLiteDatabase): void {
  sqlite.run(
    `update pi_memory_items set scope_id=?
      where lower(scope)='skill' and lower(trim(scope_id))=?`,
    [DEFAULT_DOMAIN_SKILL_ID, LEGACY_DOMAIN_SKILL_ID]
  );
}

function migrateLegacyDomainRunEvents(sqlite: SQLiteDatabase): void {
  const existing = migratedLegacyEventIDs(sqlite);
  const rows = sqlite.query<LegacyDomainEvent, [string]>(
    `select id, action_id, project_id, issue_id, conversation_id,
      payload_json, error, heartbeat_id
      from pi_action_events where event_type=? order by id`
  ).all(LEGACY_DOMAIN_EVENT_TYPE);
  for (const row of rows) {
    if (existing.has(row.id)) continue;
    const legacy = objectValue(parseJSON(row.payload_json));
    const status = row.error.trim() === "" ? "succeeded" : "failed";
    const payload = {
      action_count: positiveInteger(legacy.action_count),
      contract: "xw.skill-run.v1",
      input_object: "inbox_item",
      item_id: positiveInteger(legacy.item_id),
      kind: "domain",
      migration_source_event_id: row.id,
      primary_intent: cleanString(legacy.primary_intent),
      skill_id: MIGRATED_DOMAIN_SKILL_ID,
      status
    };
    sqlite.run(
      `insert into pi_action_events
        (action_id, project_id, issue_id, conversation_id, event_type, actor,
         decision, reason, payload_json, result_json, error, delegation_id,
         heartbeat_id, created_at)
       values (?, ?, ?, ?, ?, 'migration', ?, ?, ?, '{}', ?, '', ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      [
        row.action_id,
        row.project_id,
        row.issue_id,
        row.conversation_id,
        SKILL_RUNTIME_COMPLETED_EVENT,
        status,
        `migrated legacy domain run event ${row.id}`,
        JSON.stringify(payload),
        row.error,
        row.heartbeat_id
      ]
    );
  }
}

function migratedLegacyEventIDs(sqlite: SQLiteDatabase): Set<number> {
  const rows = sqlite.query<{ payload_json: string }, [string]>(
    "select payload_json from pi_action_events where event_type=? and actor='migration'"
  ).all(SKILL_RUNTIME_COMPLETED_EVENT);
  return new Set(rows
    .map((row) => positiveInteger(objectValue(parseJSON(row.payload_json)).migration_source_event_id))
    .filter(Boolean));
}

function parseArray(value: string): unknown[] {
  const parsed = parseJSON(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJSON(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeID(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
