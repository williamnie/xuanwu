import type { RunnerDatabase } from "../database.ts";

export type ImContextDirection = "inbound" | "outbound";
export type ImContextProjectionEvent = {
  direction: ImContextDirection;
  included: boolean;
  messageRef: string;
  projectionHash: string;
  sourceRowID: number;
};
export type ImContextProjectionReservation = {
  accepted: Array<{ direction: ImContextDirection; sourceRowID: number }>;
  bindingIDs: number[];
  connectorID: string;
  conversationID: string;
  scopeKey: string;
  turnID: string;
};
export type ImContextCursor = {
  connector_id: string;
  conversation_id: string;
  inbound_event_id: number;
  outbound_outbox_id: number;
  scope_key: string;
  updated_at: string;
};
export type ImContextRollover = {
  activated_at: string;
  capsule_json: string;
  child_conversation_id: string;
  child_epoch: number;
  connector_id: string;
  created_at: string;
  error: string;
  expected_active_conversation_id: string;
  id: string;
  parent_conversation_id: string;
  parent_epoch: number;
  scope_key: string;
  status: "activated" | "failed" | "preparing";
  trigger: string;
};

export function getImContextCursor(
  db: RunnerDatabase,
  input: { connectorID: string; conversationID: string; scopeKey: string }
): ImContextCursor | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string, string]>(`
    select connector_id, scope_key, conversation_id, inbound_event_id, outbound_outbox_id, updated_at
    from im_context_cursors where connector_id=? and scope_key=? and conversation_id=?
  `).get(required(input.connectorID, "connectorID"), required(input.scopeKey, "scopeKey"),
    required(input.conversationID, "conversationID"));
  return row ? mapCursor(row) : null;
}

export function reserveImContextProjection(
  db: RunnerDatabase,
  input: {
    connectorID: string;
    conversationID: string;
    events: ImContextProjectionEvent[];
    scopeKey: string;
    turnID: string;
  },
  now = new Date()
): ImContextProjectionReservation {
  const connectorID = required(input.connectorID, "connectorID");
  const conversationID = required(input.conversationID, "conversationID");
  const scopeKey = required(input.scopeKey, "scopeKey");
  const turnID = required(input.turnID, "turnID");
  const reserve = db.transaction(() => {
    for (const event of input.events) {
      db.sqlite.run(`insert into im_context_event_bindings
        (connector_id, scope_key, conversation_id, turn_id, direction, source_row_id,
         message_ref, projection_hash, status, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
        on conflict(connector_id, direction, source_row_id, conversation_id) do update set
          scope_key=excluded.scope_key,
          turn_id=excluded.turn_id,
          message_ref=excluded.message_ref,
          projection_hash=excluded.projection_hash,
          status='reserved',
          created_at=excluded.created_at,
          presented_at='',
          error=''
        where im_context_event_bindings.status='failed'`, [
        connectorID, scopeKey, conversationID, turnID, direction(event.direction),
        positiveInteger(event.sourceRowID), clean(event.messageRef), required(event.projectionHash, "projectionHash"),
        now.toISOString()
      ]);
    }
    const rows = db.sqlite.query<{ direction: string; id: number; source_row_id: number }, [string, string]>(`
      select id, direction, source_row_id from im_context_event_bindings
      where conversation_id=? and turn_id=? and status='reserved' order by id asc
    `).all(conversationID, turnID);
    return {
      accepted: rows.map((row) => ({ direction: direction(row.direction), sourceRowID: row.source_row_id })),
      bindingIDs: rows.map((row) => row.id), connectorID, conversationID, scopeKey, turnID
    };
  });
  return reserve.immediate();
}

export function markImContextProjectionPresented(
  db: RunnerDatabase,
  reservation: ImContextProjectionReservation,
  now = new Date()
): void {
  if (reservation.bindingIDs.length === 0) return;
  const mark = db.transaction(() => {
    db.sqlite.run(`update im_context_event_bindings set status='presented', presented_at=?, error=''
      where conversation_id=? and turn_id=? and status='reserved'`, [
      now.toISOString(), reservation.conversationID, reservation.turnID
    ]);
    const maxima = db.sqlite.query<{ direction: string; max_id: number }, [string, string]>(`
      select direction, max(source_row_id) as max_id from im_context_event_bindings
      where conversation_id=? and turn_id=? and status='presented' group by direction
    `).all(reservation.conversationID, reservation.turnID);
    const inbound = maxima.find((row) => row.direction === "inbound")?.max_id ?? 0;
    const outbound = maxima.find((row) => row.direction === "outbound")?.max_id ?? 0;
    const current = getImContextCursor(db, reservation) ?? {
      connector_id: reservation.connectorID,
      conversation_id: reservation.conversationID,
      inbound_event_id: 0,
      outbound_outbox_id: 0,
      scope_key: reservation.scopeKey,
      updated_at: now.toISOString()
    };
    db.sqlite.run(`insert into im_context_cursors
      (connector_id, scope_key, conversation_id, inbound_event_id, outbound_outbox_id, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(connector_id, scope_key, conversation_id) do update set
        inbound_event_id=max(inbound_event_id, excluded.inbound_event_id),
        outbound_outbox_id=max(outbound_outbox_id, excluded.outbound_outbox_id),
        updated_at=excluded.updated_at`, [
      reservation.connectorID, reservation.scopeKey, reservation.conversationID,
      Math.max(current.inbound_event_id, inbound), Math.max(current.outbound_outbox_id, outbound), now.toISOString()
    ]);
  });
  mark.immediate();
}

export function failImContextProjectionReservation(
  db: RunnerDatabase,
  reservation: ImContextProjectionReservation,
  error = "turn_not_presented"
): void {
  db.sqlite.run(`update im_context_event_bindings set status='failed', error=?
    where conversation_id=? and turn_id=? and status='reserved'`, [
    bounded(error, 240), reservation.conversationID, reservation.turnID
  ]);
}

export function reconcileReservedImContextBindings(db: RunnerDatabase): number {
  const result = db.sqlite.run(`update im_context_event_bindings
    set status='failed', error='process_restart_before_turn_start'
    where status='reserved'`);
  return Number(result.changes);
}

export function prepareImContextRollover(
  db: RunnerDatabase,
  input: {
    baseConversationID: string;
    capsule: Record<string, unknown>;
    connectorID: string;
    parentConversationID: string;
    parentEpoch: number;
    scopeKey: string;
    trigger: string;
  },
  now = new Date()
): ImContextRollover {
  const childEpoch = nonNegativeInteger(input.parentEpoch) + 1;
  const childConversationID = `${required(input.baseConversationID, "baseConversationID")}-n${childEpoch}`;
  const connectorID = required(input.connectorID, "connectorID");
  const scopeKey = required(input.scopeKey, "scopeKey");
  const id = `im-rollover:${connectorID}:${scopeKey}:${childEpoch}`;
  db.sqlite.run(`insert or ignore into im_context_rollovers
    (id, connector_id, scope_key, parent_conversation_id, child_conversation_id,
     parent_epoch, child_epoch, trigger, status, capsule_json, expected_active_conversation_id, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`, [
    id, connectorID, scopeKey, required(input.parentConversationID, "parentConversationID"),
    childConversationID, nonNegativeInteger(input.parentEpoch), childEpoch, required(input.trigger, "trigger"),
    JSON.stringify(input.capsule), input.parentConversationID, now.toISOString()
  ]);
  return requireRollover(db, id);
}

export function activateImContextRollover(
  db: RunnerDatabase,
  rolloverID: string,
  now = new Date()
): { activated: boolean; rollover: ImContextRollover } {
  const activate = db.transaction(() => {
    const rollover = requireRollover(db, rolloverID);
    if (rollover.status === "activated") return { activated: true, rollover };
    if (rollover.status === "failed") return { activated: false, rollover };
    db.sqlite.run(`update im_conversation_state set active_conversation_id=?, epoch=?, updated_at=?
      where connector_id=? and scope_key=? and active_conversation_id=? and epoch=?`, [
      rollover.child_conversation_id, rollover.child_epoch, now.toISOString(), rollover.connector_id,
      rollover.scope_key, rollover.expected_active_conversation_id, rollover.parent_epoch
    ]);
    const state = db.sqlite.query<{ active_conversation_id: string }, [string, string]>(`
      select active_conversation_id from im_conversation_state where connector_id=? and scope_key=?
    `).get(rollover.connector_id, rollover.scope_key);
    const activated = state?.active_conversation_id === rollover.child_conversation_id;
    db.sqlite.run(`update im_context_rollovers set status=?, activated_at=?, error=? where id=?`, [
      activated ? "activated" : "failed", activated ? now.toISOString() : "",
      activated ? "" : "active_conversation_compare_and_set_failed", rollover.id
    ]);
    return { activated, rollover: requireRollover(db, rollover.id) };
  });
  return activate.immediate();
}

export function getImContextRollover(db: RunnerDatabase, id: string): ImContextRollover | null {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select id, connector_id, scope_key, parent_conversation_id, child_conversation_id,
      parent_epoch, child_epoch, trigger, status, capsule_json, expected_active_conversation_id,
      created_at, activated_at, error from im_context_rollovers where id=?
  `).get(clean(id));
  return row ? mapRollover(row) : null;
}

function requireRollover(db: RunnerDatabase, id: string): ImContextRollover {
  const rollover = getImContextRollover(db, id);
  if (!rollover) throw new Error("IM context rollover missing after write");
  return rollover;
}

function mapCursor(row: Record<string, unknown>): ImContextCursor {
  return {
    connector_id: required(row.connector_id, "connector_id"),
    conversation_id: required(row.conversation_id, "conversation_id"),
    inbound_event_id: nonNegativeInteger(row.inbound_event_id),
    outbound_outbox_id: nonNegativeInteger(row.outbound_outbox_id),
    scope_key: required(row.scope_key, "scope_key"),
    updated_at: required(row.updated_at, "updated_at")
  };
}

function mapRollover(row: Record<string, unknown>): ImContextRollover {
  const status = clean(row.status);
  if (!(["activated", "failed", "preparing"] as const).includes(status as never)) {
    throw new Error("invalid IM context rollover status");
  }
  return {
    activated_at: clean(row.activated_at), capsule_json: required(row.capsule_json, "capsule_json"),
    child_conversation_id: required(row.child_conversation_id, "child_conversation_id"),
    child_epoch: nonNegativeInteger(row.child_epoch), connector_id: required(row.connector_id, "connector_id"),
    created_at: required(row.created_at, "created_at"), error: clean(row.error), id: required(row.id, "id"),
    expected_active_conversation_id: required(row.expected_active_conversation_id, "expected_active_conversation_id"),
    parent_conversation_id: required(row.parent_conversation_id, "parent_conversation_id"),
    parent_epoch: nonNegativeInteger(row.parent_epoch), scope_key: required(row.scope_key, "scope_key"),
    status: status as ImContextRollover["status"], trigger: required(row.trigger, "trigger")
  };
}

function direction(value: unknown): ImContextDirection {
  if (value === "inbound" || value === "outbound") return value;
  throw new Error("invalid IM context direction");
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("sourceRowID must be a positive integer");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function required(value: unknown, name: string): string {
  const text = clean(value);
  if (text === "") throw new Error(`${name} is required`);
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
