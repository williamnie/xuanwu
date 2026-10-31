import { randomBytes } from "node:crypto";
import type { RunnerDatabase } from "../database.ts";
import { cleanString } from "../../util/values.ts";
import {
  type ImInteractionBindingInput,
  type ImInteractionBinding,
  requireString,
  normalizeActions,
  positiveRevision,
  COLUMNS,
  mapBinding,
  type ImInteractionConsumeResult,
  actorMatches,
  type ImInteractionClaimResult,
  boundedLeaseMs,
  interactionConstraintFailure,
  boundedResolutionJson
} from "./imInteractionBindingsModel.ts";

/** At least 128 bit of entropy; base64url keeps it callback-payload safe. */
export function newImInteractionToken(): string {
  return randomBytes(16).toString("base64url");
}

export function createImInteractionBinding(
  db: RunnerDatabase,
  input: ImInteractionBindingInput,
  timestamp = new Date()
): ImInteractionBinding {
  const iso = timestamp.toISOString();
  const record: ImInteractionBinding = {
    action_kind: requireString(input.actionKind, "action_kind"),
    action_ref: requireString(input.actionRef, "action_ref"),
    actions: normalizeActions(input.actions),
    actor_id: cleanString(input.actor.id),
    actor_open_id: cleanString(input.actor.openId),
    claimed_action_id: "",
    connector_id: requireString(input.connectorId, "connector_id"),
    consumed_at: "",
    conversation_id: cleanString(input.conversationId),
    created_at: iso,
    expires_at: requireString(input.expiresAt, "expires_at"),
    interaction_id: cleanString(input.interactionId) || newImInteractionToken(),
    lease_expires_at: "",
    lease_id: "",
    revision: positiveRevision(input.revision),
    resolution_json: "",
    resolved_at: "",
    scope_key: requireString(input.scopeKey, "scope_key"),
    source_message_id: cleanString(input.sourceMessageId),
    status: "pending",
    updated_at: iso
  };
  if (record.actor_id === "" && record.actor_open_id === "") throw new Error("interaction actor is required");
  db.sqlite.run(
    `insert into im_interaction_bindings (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.interaction_id, record.connector_id, record.action_kind, record.action_ref,
      JSON.stringify(record.actions), record.actor_id, record.actor_open_id,
      record.scope_key, record.conversation_id, record.source_message_id, record.status,
      record.revision, record.expires_at, record.claimed_action_id, record.lease_id,
      record.lease_expires_at, record.resolution_json, record.resolved_at,
      record.consumed_at, record.created_at, record.updated_at
    ]
  );
  const saved = getImInteractionBinding(db, record.interaction_id);
  if (!saved) throw new Error("im interaction binding missing after write");
  return saved;
}

/** Retry-safe creation: a transport retry reuses the same opaque token. */
export function ensureImInteractionBinding(
  db: RunnerDatabase,
  input: ImInteractionBindingInput,
  timestamp = new Date()
): ImInteractionBinding {
  const existing = db.sqlite.query<Record<string, unknown>, [string, string, string]>(
    `select ${COLUMNS} from im_interaction_bindings
     where connector_id=? and action_ref=? and scope_key=? and status='pending'
     order by created_at desc limit 1`
  ).get(requireString(input.connectorId, "connector_id"), requireString(input.actionRef, "action_ref"), requireString(input.scopeKey, "scope_key"));
  if (existing) {
    const binding = mapBinding(existing);
    const actions = normalizeActions(input.actions);
    if (binding.actor_id !== cleanString(input.actor.id) ||
      binding.actor_open_id !== cleanString(input.actor.openId) ||
      JSON.stringify(binding.actions) !== JSON.stringify(actions) ||
      binding.revision !== positiveRevision(input.revision)) {
      throw new Error("existing im interaction binding constraints do not match");
    }
    return binding;
  }
  return createImInteractionBinding(db, input, timestamp);
}

export function getImInteractionBinding(
  db: RunnerDatabase,
  interactionId: string
): ImInteractionBinding | null {
  const id = cleanString(interactionId);
  if (id === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from im_interaction_bindings where interaction_id=?`
  ).get(id);
  return row ? mapBinding(row) : null;
}

/**
 * Consume-once with connector/scope/expiry gating. The caller still must
 * verify actor and revision against the authoritative business record; this
 * transition only guarantees a single transport consume.
 */
export function consumeImInteractionBinding(
  db: RunnerDatabase,
  input: {
    actionId: string;
    actor: { id?: string; openId?: string };
    connectorId: string;
    interactionId: string;
    now?: Date;
    revision: number;
    scopeKey: string;
  }
): ImInteractionConsumeResult {
  const now = input.now ?? new Date();
  const write = db.transaction(() => {
    const current = getImInteractionBinding(db, input.interactionId);
    if (!current) return { binding: null, status: "missing" as const };
    if (current.connector_id !== cleanString(input.connectorId)) {
      return { binding: current, status: "source_mismatch" as const };
    }
    const scopeKey = cleanString(input.scopeKey);
    if (scopeKey === "" || current.scope_key !== scopeKey) {
      return { binding: current, status: "source_mismatch" as const };
    }
    if (!actorMatches(current, input.actor)) return { binding: current, status: "actor_mismatch" as const };
    if (current.revision !== input.revision) return { binding: current, status: "revision_mismatch" as const };
    if (!current.actions.some((action) => action.action_id === cleanString(input.actionId))) {
      return { binding: current, status: "action_mismatch" as const };
    }
    if (current.status === "consumed") return { binding: current, status: "already_consumed" as const };
    if (Date.parse(current.expires_at) <= now.getTime()) {
      return { binding: current, status: "expired" as const };
    }
    const iso = now.toISOString();
    const updated = db.sqlite.run(
      `update im_interaction_bindings set status='consumed', consumed_at=?, updated_at=?
       where interaction_id=? and status='pending'`,
      [iso, iso, current.interaction_id]
    );
    if (Number(updated.changes ?? 0) !== 1) {
      return { binding: getImInteractionBinding(db, current.interaction_id), status: "already_consumed" as const };
    }
    return { binding: getImInteractionBinding(db, current.interaction_id), status: "consumed" as const };
  });
  return write.immediate();
}

/**
 * Claim a binding for resolver execution without consuming it. A live lease
 * suppresses concurrent callbacks; the exact same constrained callback may
 * reclaim an expired lease after a crash. Completion is a separate CAS.
 */
export function claimImInteractionBinding(
  db: RunnerDatabase,
  input: {
    actionId: string;
    actor: { id?: string; openId?: string };
    connectorId: string;
    interactionId: string;
    leaseMs?: number;
    now?: Date;
    revision: number;
    scopeKey: string;
  }
): ImInteractionClaimResult {
  const now = input.now ?? new Date();
  const actionId = cleanString(input.actionId);
  const leaseMs = boundedLeaseMs(input.leaseMs);
  return db.transaction((): ImInteractionClaimResult => {
    const current = getImInteractionBinding(db, input.interactionId);
    const failure = interactionConstraintFailure(current, { ...input, actionId }, now);
    if (failure) return failure;
    if (!current) return { binding: null, leaseId: "", status: "missing" };
    if (current.status === "consumed") {
      return { binding: current, leaseId: "", status: "already_consumed" };
    }
    if (current.status === "executing") {
      if (current.claimed_action_id !== actionId) {
        return { binding: current, leaseId: "", status: "already_consumed" };
      }
      if (Date.parse(current.lease_expires_at) > now.getTime()) {
        return { binding: current, leaseId: "", status: "resolution_in_progress" };
      }
    }
    const leaseId = newImInteractionToken();
    const iso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const expectedStatus = current.status;
    const expectedLeaseId = current.lease_id;
    const updated = db.sqlite.run(
      `update im_interaction_bindings
       set status='executing', claimed_action_id=?, lease_id=?, lease_expires_at=?, updated_at=?
       where interaction_id=? and status=? and lease_id=?`,
      [actionId, leaseId, leaseExpiresAt, iso, current.interaction_id, expectedStatus, expectedLeaseId]
    );
    if (Number(updated.changes ?? 0) !== 1) {
      return { binding: getImInteractionBinding(db, current.interaction_id), leaseId: "", status: "resolution_in_progress" };
    }
    return { binding: getImInteractionBinding(db, current.interaction_id), leaseId, status: "claimed" };
  }).immediate();
}

/** Mark a claimed resolver attempt complete only if this process still owns the lease. */
export function completeImInteractionBinding(
  db: RunnerDatabase,
  input: { interactionId: string; leaseId: string; resolution: unknown; now?: Date }
): ImInteractionBinding | null {
  const now = input.now ?? new Date();
  const interactionId = cleanString(input.interactionId);
  const leaseId = cleanString(input.leaseId);
  if (interactionId === "" || leaseId === "") return null;
  const iso = now.toISOString();
  const updated = db.sqlite.run(
    `update im_interaction_bindings
     set status='consumed', consumed_at=?, resolved_at=?, resolution_json=?,
         lease_id='', lease_expires_at='', updated_at=?
     where interaction_id=? and status='executing' and lease_id=?`,
    [iso, iso, boundedResolutionJson(input.resolution), iso, interactionId, leaseId]
  );
  return Number(updated.changes ?? 0) === 1 ? getImInteractionBinding(db, interactionId) : null;
}

export type { ImInteractionBindingAction } from "./imInteractionBindingsModel.ts";
export type { ImInteractionBinding } from "./imInteractionBindingsModel.ts";
