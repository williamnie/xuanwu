import type { RunnerDatabase } from "../database.ts";

export type ConnectorCursorRecord = {
  connector_id: string;
  position: string;
  scope: string;
  updated_at: string;
};

export type ConnectorDeliveryPart = {
  connector_id: string;
  content_hash: string;
  created_at: string;
  idempotency_key: string;
  part_count: number;
  part_index: number;
  provider_request_ref: string;
};

export function getConnectorCursor(
  db: RunnerDatabase,
  connectorId: string,
  scope: string
): ConnectorCursorRecord | null {
  const connector = required(connectorId, "connector_id");
  const cursorScope = required(scope, "scope");
  return db.sqlite.query<ConnectorCursorRecord, [string, string]>(
    `select connector_id, scope, position, updated_at from connector_cursors
     where connector_id=? and scope=?`
  ).get(connector, cursorScope) ?? null;
}

export function saveConnectorCursor(
  db: RunnerDatabase,
  input: { connectorId: string; position: string; scope: string; updatedAt?: Date }
): ConnectorCursorRecord {
  const connector = required(input.connectorId, "connector_id");
  const scope = required(input.scope, "scope");
  const position = required(input.position, "position");
  const updatedAt = (input.updatedAt ?? new Date()).toISOString();
  db.sqlite.run(
    `insert into connector_cursors (connector_id, scope, position, updated_at)
     values (?, ?, ?, ?)
     on conflict(connector_id, scope) do update set
       position=excluded.position, updated_at=excluded.updated_at`,
    [connector, scope, position, updatedAt]
  );
  return getConnectorCursor(db, connector, scope)!;
}

export function recordConnectorUpdateAudit(
  db: RunnerDatabase,
  input: {
    connectorId: string;
    updateId: string;
    outcome: "accepted" | "callback" | "edited" | "ignored" | "rejected";
    reason?: string;
    createdAt?: Date;
  }
): void {
  db.sqlite.run(
    `insert or ignore into connector_update_audits
       (connector_id, update_id, outcome, reason, created_at)
     values (?, ?, ?, ?, ?)`,
    [
      required(input.connectorId, "connector_id"),
      required(input.updateId, "update_id"),
      input.outcome,
      clean(input.reason),
      (input.createdAt ?? new Date()).toISOString()
    ]
  );
}

export function listConnectorDeliveryParts(
  db: RunnerDatabase,
  connectorId: string,
  idempotencyKey: string
): ConnectorDeliveryPart[] {
  return db.sqlite.query<ConnectorDeliveryPart, [string, string]>(
    `select connector_id, idempotency_key, part_index, part_count,
            content_hash, provider_request_ref, created_at
       from connector_delivery_parts
      where connector_id=? and idempotency_key=?
      order by part_index asc`
  ).all(required(connectorId, "connector_id"), required(idempotencyKey, "idempotency_key"));
}

export function saveConnectorDeliveryPart(
  db: RunnerDatabase,
  input: Omit<ConnectorDeliveryPart, "connector_id" | "created_at"> & {
    connectorId: string;
    createdAt?: Date;
  }
): ConnectorDeliveryPart {
  if (!Number.isSafeInteger(input.part_index) || input.part_index < 0) throw new Error("part_index is invalid");
  if (!Number.isSafeInteger(input.part_count) || input.part_count <= input.part_index) throw new Error("part_count is invalid");
  const connector = required(input.connectorId, "connector_id");
  const key = required(input.idempotency_key, "idempotency_key");
  const hash = required(input.content_hash, "content_hash");
  const ref = required(input.provider_request_ref, "provider_request_ref");
  const existing = listConnectorDeliveryParts(db, connector, key).find((part) => part.part_index === input.part_index);
  if (existing) {
    if (existing.content_hash !== hash || existing.part_count !== input.part_count) {
      throw new Error("connector delivery part does not match the durable split");
    }
    return existing;
  }
  db.sqlite.run(
    `insert into connector_delivery_parts
       (connector_id, idempotency_key, part_index, part_count, content_hash,
        provider_request_ref, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [connector, key, input.part_index, input.part_count, hash, ref, (input.createdAt ?? new Date()).toISOString()]
  );
  return listConnectorDeliveryParts(db, connector, key).find((part) => part.part_index === input.part_index)!;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(value: unknown, label: string): string {
  const text = clean(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
