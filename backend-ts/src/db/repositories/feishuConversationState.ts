import type { RunnerDatabase } from "../database.ts";

export type FeishuConversationState = {
  active_conversation_id: string;
  active_project_id: string;
  active_project_source: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

export type FeishuActiveProjectSource =
  "explicit_project" | "issue_ref" | "user_switch" | "card_select" | "mapping_default";

export type FeishuConversationEpochInput = {
  baseConversationId: string;
  scopeKey: string;
};

export type FeishuConversationActiveProjectInput = {
  activeConversationId?: string;
  activeProjectId: string;
  scopeKey: string;
  source: FeishuActiveProjectSource;
};

const COLUMNS = `scope_key, active_conversation_id, active_project_id,
  active_project_source, epoch, started_at, updated_at`;

export function getFeishuConversationState(
  db: RunnerDatabase,
  scopeKey: string
): FeishuConversationState | null {
  const key = cleanString(scopeKey);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from feishu_conversation_state where scope_key=?`
  ).get(key);
  return row ? mapState(row) : null;
}

export function bumpFeishuConversationEpoch(
  db: RunnerDatabase,
  input: FeishuConversationEpochInput,
  timestamp = new Date()
): FeishuConversationState {
  const write = db.transaction(() => {
    const current = getFeishuConversationState(db, input.scopeKey);
    const record = epochStateRecord(input, current, timestamp);
    db.sqlite.run(
      `insert into feishu_conversation_state (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(scope_key) do update set
         active_conversation_id=excluded.active_conversation_id,
         active_project_id=excluded.active_project_id,
         active_project_source=excluded.active_project_source,
         epoch=excluded.epoch,
         started_at=excluded.started_at,
         updated_at=excluded.updated_at`,
      insertValues(record)
    );
    return requireSavedState(db, record.scope_key);
  });
  return write.immediate();
}

export function setFeishuConversationActiveProject(
  db: RunnerDatabase,
  input: FeishuConversationActiveProjectInput,
  timestamp = new Date()
): FeishuConversationState {
  const write = db.transaction(() => {
    const current = getFeishuConversationState(db, input.scopeKey);
    const record = activeProjectStateRecord(input, current, timestamp);
    db.sqlite.run(
      `insert into feishu_conversation_state (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(scope_key) do update set
         active_conversation_id=excluded.active_conversation_id,
         active_project_id=excluded.active_project_id,
         active_project_source=excluded.active_project_source,
         epoch=excluded.epoch,
         updated_at=excluded.updated_at`,
      insertValues(record)
    );
    return requireSavedState(db, record.scope_key);
  });
  return write.immediate();
}

function insertValues(record: FeishuConversationState): Array<number | string> {
  return [
    record.scope_key,
    record.active_conversation_id,
    record.active_project_id,
    record.active_project_source,
    record.epoch,
    record.started_at,
    record.updated_at
  ];
}

function requireSavedState(db: RunnerDatabase, scopeKey: string): FeishuConversationState {
  const saved = getFeishuConversationState(db, scopeKey);
  if (!saved) throw new Error("Feishu conversation state missing after write");
  return saved;
}

function epochStateRecord(
  input: FeishuConversationEpochInput,
  current: FeishuConversationState | null,
  timestamp: Date
): FeishuConversationState {
  const scopeKey = requireString(input.scopeKey, "scope_key");
  const baseID = requireString(input.baseConversationId, "base_conversation_id");
  const epoch = (current?.epoch ?? 0) + 1;
  const iso = timestamp.toISOString();
  return {
    active_conversation_id: `${baseID}-n${epoch}`,
    active_project_id: current?.active_project_id ?? "",
    active_project_source: current?.active_project_source ?? "",
    epoch,
    scope_key: scopeKey,
    started_at: iso,
    updated_at: iso
  };
}

function activeProjectStateRecord(
  input: FeishuConversationActiveProjectInput,
  current: FeishuConversationState | null,
  timestamp: Date
): FeishuConversationState {
  const scopeKey = requireString(input.scopeKey, "scope_key");
  const projectID = requireString(input.activeProjectId, "active_project_id");
  const source = validActiveProjectSource(input.source);
  const iso = timestamp.toISOString();
  return {
    active_conversation_id: cleanString(input.activeConversationId) ||
      current?.active_conversation_id || scopeKey,
    active_project_id: projectID,
    active_project_source: source,
    epoch: current?.epoch ?? 0,
    scope_key: scopeKey,
    started_at: current?.started_at ?? iso,
    updated_at: iso
  };
}

function mapState(row: Record<string, unknown>): FeishuConversationState {
  return {
    active_conversation_id: requireString(row.active_conversation_id, "active_conversation_id"),
    active_project_id: cleanString(row.active_project_id),
    active_project_source: cleanString(row.active_project_source),
    epoch: integerValue(row.epoch, "epoch"),
    scope_key: requireString(row.scope_key, "scope_key"),
    started_at: requireString(row.started_at, "started_at"),
    updated_at: requireString(row.updated_at, "updated_at")
  };
}

function requireString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function validActiveProjectSource(value: unknown): FeishuActiveProjectSource {
  const source = cleanString(value);
  if (
    source === "explicit_project" || source === "issue_ref" ||
    source === "user_switch" || source === "card_select" ||
    source === "mapping_default"
  ) return source;
  throw new Error("active_project_source is invalid");
}
