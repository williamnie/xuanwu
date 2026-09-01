import type { PiActionEnvelope } from "./actionGate.ts";
import type { PiActionContext, PiActionRequest } from "./actionEngine.ts";
import { guardianActionLeaseKey } from "./guardianActionLease.ts";

export type ActionRecordMetadata = {
  before_snapshot_json: string;
  expected_state_json: string;
  idempotency_key: string;
  lease_expires_at: string;
  lease_key: string;
  legacy_bypass_reason: string;
};

export function actionRecordMetadata(
  input: PiActionRequest,
  context: PiActionContext,
  envelope: PiActionEnvelope
): ActionRecordMetadata {
  return {
    before_snapshot_json: beforeSnapshotJson(envelope.payload),
    expected_state_json: expectedStateJson(envelope.payload),
    idempotency_key: actionIdempotencyKey(input, context, envelope),
    lease_expires_at: "",
    lease_key: leaseKeyFromEnvelope(envelope),
    legacy_bypass_reason: legacyBypassReason(context, envelope)
  };
}

function actionIdempotencyKey(
  input: PiActionRequest,
  context: PiActionContext,
  envelope: PiActionEnvelope
): string {
  const explicit = cleanString(input.idempotencyKey) || cleanString(envelope.idempotency_key);
  if (explicit !== "") return explicit;
  const guardianDecisionID = cleanString(input.guardianDecisionID) ||
    cleanString(context.guardianDecisionID) || cleanString(envelope.guardian_decision_id);
  if (guardianDecisionID === "") return "";
  return [
    "guardian_action",
    guardianDecisionID,
    envelope.action_type,
    cleanString(envelope.project_id) || "global",
    envelope.issue_id ?? 0,
    payloadHash(envelope.payload)
  ].join(":");
}

function leaseKeyFromEnvelope(envelope: PiActionEnvelope): string {
  if (cleanString(envelope.guardian_decision_id) === "") return "";
  return guardianActionLeaseKey({
    actionType: envelope.action_type,
    issueID: envelope.issue_id,
    projectID: envelope.project_id
  });
}

function legacyBypassReason(context: PiActionContext, envelope: PiActionEnvelope): string {
  if (cleanString(envelope.guardian_decision_id) !== "") return "";
  return cleanString(context.legacyBypassReason) || "legacy_direct_action";
}

function expectedStateJson(payload: Record<string, unknown>): string {
  const expected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "expected_state" && key.startsWith("expected_")) {
      expected[key.slice("expected_".length)] = value;
    }
  }
  const explicit = objectPayload(payload.expected_state);
  return stableJson({ ...expected, ...explicit });
}

function beforeSnapshotJson(payload: Record<string, unknown>): string {
  return stableJson(objectPayload(payload.before_snapshot));
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function payloadHash(payload: Record<string, unknown>): string {
  return Bun.hash(stableJson(payload), 0).toString(16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
