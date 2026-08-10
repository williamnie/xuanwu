import type { RunnerDatabase } from "../database.ts";

/**
 * Provider-neutral IM conversation state repository (A3, design
 * 2026-08-02-generic-im-channel-telegram-design.md §7.1). It stores only the
 * per-scope conversation epoch — never an active project. All provider ids
 * (connector/conversation/thread) are opaque strings; scope keys are computed
 * by the routing layer and stored verbatim.
 *
 * `feishu_conversation_state` is kept as a read-only historical carrier for
 * the bounded W1 window; the migration backfill is the only write path into
 * this table for pre-cutover rows, and this repository is the single
 * application writer going forward.
 */
export type ImConversationState = {
  active_conversation_id: string;
  base_conversation_id: string;
  connector_id: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

export type ImConversationEpochInput = {
  baseConversationId: string;
  connectorId: string;
  scopeKey: string;
};

export type ImConversationAdoptionInput = {
  activeConversationId: string;
  baseConversationId: string;
  connectorId: string;
  epoch?: number;
  scopeKey: string;
  startedAt?: string;
};

const COLUMNS = `connector_id, scope_key, base_conversation_id, active_conversation_id,
  epoch, started_at, updated_at`;

export function getImConversationState(
  db: RunnerDatabase,
  connectorId: string,
  scopeKey: string
): ImConversationState | null {
  const connector = cleanString(connectorId);
  const key = cleanString(scopeKey);
  if (connector === "" || key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from im_conversation_state where connector_id=? and scope_key=?`
  ).get(connector, key);
  return row ? mapState(row) : null;
}

/** Resolve a persisted application conversation without parsing its id. */
export function findImConversationStateByConversationID(
  db: RunnerDatabase,
  conversationId: string
): ImConversationState | null {
  const id = cleanString(conversationId);
  if (id === "") return null;
  const rows = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from im_conversation_state
     where active_conversation_id=? or base_conversation_id=?
     order by updated_at desc, connector_id asc limit 2`
  ).all(id, id);
  if (rows.length !== 1) return null;
  return mapState(rows[0]!);
}

export function bumpImConversationEpoch(
  db: RunnerDatabase,
  input: ImConversationEpochInput,
  timestamp = new Date()
): ImConversationState {
  const write = db.transaction(() => {
    const current = getImConversationState(db, input.connectorId, input.scopeKey);
    const record = epochStateRecord(input, current, timestamp);
    db.sqlite.run(
      `insert into im_conversation_state (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(connector_id, scope_key) do update set
         active_conversation_id=excluded.active_conversation_id,
         epoch=excluded.epoch,
         updated_at=excluded.updated_at`,
      stateValues(record)
    );
    return requireSavedState(db, record.connector_id, record.scope_key);
  });
  return write.immediate();
}

export function adoptImConversationState(
  db: RunnerDatabase,
  input: ImConversationAdoptionInput,
  timestamp = new Date()
): ImConversationState {
  const existing = getImConversationState(db, input.connectorId, input.scopeKey);
  if (existing) return existing;
  const iso = timestamp.toISOString();
  const record: ImConversationState = {
    active_conversation_id: requireString(input.activeConversationId, "active_conversation_id"),
    base_conversation_id: requireString(input.baseConversationId, "base_conversation_id"),
    connector_id: requireString(input.connectorId, "connector_id"),
    epoch: nonNegativeInteger(input.epoch),
    scope_key: requireString(input.scopeKey, "scope_key"),
    started_at: cleanString(input.startedAt) || iso,
    updated_at: iso
  };
  db.sqlite.run(
    `insert or ignore into im_conversation_state (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?)`,
    stateValues(record)
  );
  return requireSavedState(db, record.connector_id, record.scope_key);
}

/**
 * Backfill parity audit (design §7.2 step 3): every legacy Feishu row must
 * have exactly one neutral row with identical scope/epoch/active conversation.
 * Returns the offending scope keys so release evidence can assert empty lists.
 */
export function auditImConversationBackfill(db: RunnerDatabase): {
  feishu_rows: number;
  im_feishu_rows: number;
  missing_scopes: string[];
  mismatched_scopes: string[];
} {
  const legacyRows = db.sqlite.query<Record<string, unknown>, []>(
    `select scope_key, active_conversation_id, epoch from feishu_conversation_state`
  ).all();
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const row of legacyRows) {
    const scopeKey = cleanString(row.scope_key);
    const current = getImConversationState(db, "feishu", scopeKey);
    if (!current) {
      missing.push(scopeKey);
      continue;
    }
    if (
      current.active_conversation_id !== cleanString(row.active_conversation_id) ||
      current.epoch !== integerValue(row.epoch, "epoch")
    ) {
      mismatched.push(scopeKey);
    }
  }
  const imFeishuRows = db.sqlite.query<{ count: number }, []>(
    `select count(*) as count from im_conversation_state where connector_id='feishu'`
  ).get()?.count ?? 0;
  return {
    feishu_rows: legacyRows.length,
    im_feishu_rows: imFeishuRows,
    missing_scopes: missing.sort(),
    mismatched_scopes: mismatched.sort()
  };
}

function epochStateRecord(
  input: ImConversationEpochInput,
  current: ImConversationState | null,
  timestamp: Date
): ImConversationState {
  const scopeKey = requireString(input.scopeKey, "scope_key");
  const connectorId = requireString(input.connectorId, "connector_id");
  const baseID = requireString(input.baseConversationId, "base_conversation_id");
  const epoch = (current?.epoch ?? 0) + 1;
  const iso = timestamp.toISOString();
  return {
    active_conversation_id: `${baseID}-n${epoch}`,
    base_conversation_id: current?.base_conversation_id ?? baseID,
    connector_id: connectorId,
    epoch,
    scope_key: scopeKey,
    started_at: current?.started_at ?? iso,
    updated_at: iso
  };
}

function stateValues(record: ImConversationState): Array<number | string> {
  return [
    record.connector_id,
    record.scope_key,
    record.base_conversation_id,
    record.active_conversation_id,
    record.epoch,
    record.started_at,
    record.updated_at
  ];
}

function requireSavedState(db: RunnerDatabase, connectorId: string, scopeKey: string): ImConversationState {
  const saved = getImConversationState(db, connectorId, scopeKey);
  if (!saved) throw new Error("im conversation state missing after write");
  return saved;
}

function mapState(row: Record<string, unknown>): ImConversationState {
  return {
    active_conversation_id: requireString(row.active_conversation_id, "active_conversation_id"),
    base_conversation_id: requireString(row.base_conversation_id, "base_conversation_id"),
    connector_id: requireString(row.connector_id, "connector_id"),
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

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
