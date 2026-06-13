import type { RunnerDatabase } from "../database.ts";

export type FeishuConversationState = {
  active_conversation_id: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

export type FeishuConversationEpochInput = {
  baseConversationId: string;
  scopeKey: string;
};

const COLUMNS = "scope_key, active_conversation_id, epoch, started_at, updated_at";

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
    const record = stateRecord(input, (current?.epoch ?? 0) + 1, timestamp);
    db.sqlite.run(
      `insert into feishu_conversation_state (${COLUMNS}) values (?, ?, ?, ?, ?)
       on conflict(scope_key) do update set
         active_conversation_id=excluded.active_conversation_id,
         epoch=excluded.epoch,
         started_at=excluded.started_at,
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

function stateRecord(
  input: FeishuConversationEpochInput,
  epoch: number,
  timestamp: Date
): FeishuConversationState {
  const scopeKey = requireString(input.scopeKey, "scope_key");
  const baseID = requireString(input.baseConversationId, "base_conversation_id");
  const iso = timestamp.toISOString();
  return {
    active_conversation_id: `${baseID}-n${epoch}`,
    epoch,
    scope_key: scopeKey,
    started_at: iso,
    updated_at: iso
  };
}

function mapState(row: Record<string, unknown>): FeishuConversationState {
  return {
    active_conversation_id: requireString(row.active_conversation_id, "active_conversation_id"),
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
