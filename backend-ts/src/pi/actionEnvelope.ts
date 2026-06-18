import { classifyPiActionRisk, type PiActionEnvelope, type PiRiskLevel } from "./actionGate.ts";

type RiskInput = { level?: unknown; requires_confirmation?: unknown; requiresConfirmation?: unknown };

export type PiActionEnvelopeInput = {
  action_type?: unknown;
  delegation_id?: unknown;
  goal_id?: unknown;
  guardian_decision_id?: unknown;
  heartbeat_id?: unknown;
  idempotency_key?: unknown;
  issue_id?: unknown;
  payload?: unknown;
  project_id?: unknown;
  rationale?: unknown;
  requires_confirmation?: unknown;
  risk?: RiskInput | unknown;
  risk_level?: unknown;
  source?: unknown;
  snoozed_until?: unknown;
};

export function normalizePiActionEnvelope(input: PiActionEnvelopeInput): PiActionEnvelope {
  const actionType = requireText(input.action_type, "action_type");
  const source = requireText(input.source, "source");
  const payload = normalizePayload(input.payload);
  const classification = classifyPiActionRisk(actionType, riskOverride(input));
  const issueID = normalizeIssueID(input.issue_id) || normalizeIssueID(payload.issue_id);
  const envelope: PiActionEnvelope = {
    action_type: actionType,
    payload,
    requires_confirmation: classification.requiresConfirmation,
    risk: {
      gate: classification.gate,
      level: classification.riskLevel,
      requires_confirmation: classification.requiresConfirmation
    },
    risk_gate: classification.gate,
    risk_level: classification.riskLevel,
    source
  };
  setText(envelope, "delegation_id", input.delegation_id);
  setText(envelope, "goal_id", input.goal_id);
  setText(envelope, "guardian_decision_id", input.guardian_decision_id);
  setText(envelope, "heartbeat_id", input.heartbeat_id);
  setText(envelope, "idempotency_key", input.idempotency_key);
  if (issueID > 0) envelope.issue_id = issueID;
  setText(envelope, "project_id", input.project_id);
  setText(envelope, "rationale", input.rationale);
  setText(envelope, "snoozed_until", input.snoozed_until);
  return envelope;
}

function riskOverride(input: PiActionEnvelopeInput) {
  const risk = objectInput(input.risk);
  return {
    requiresConfirmation: booleanInput(input.requires_confirmation ?? risk.requires_confirmation ?? risk.requiresConfirmation),
    riskLevel: riskLevelInput(input.risk_level ?? risk.level)
  };
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined) throw new Error("payload is required");
  if (!isPlainObject(value)) throw new Error("payload must be a JSON object");
  assertJsonSerializable(value);
  return value;
}

function assertJsonSerializable(value: Record<string, unknown>): void {
  assertJsonValue(value, new WeakSet());
  try {
    if (JSON.stringify(value) !== JSON.stringify(JSON.parse(JSON.stringify(value)))) {
      throw new Error("unstable payload");
    }
  } catch {
    throw new Error("payload must be JSON serializable");
  }
}

function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) return assertJsonArray(value, seen);
  if (!isPlainObject(value)) throw new Error("payload must be JSON serializable");
  if (seen.has(value)) throw new Error("payload must be JSON serializable");
  seen.add(value);
  for (const entry of Object.values(value)) assertJsonValue(entry, seen);
  seen.delete(value);
}

function assertJsonArray(value: unknown[], seen: WeakSet<object>): void {
  if (seen.has(value)) throw new Error("payload must be JSON serializable");
  seen.add(value);
  for (const entry of value) assertJsonValue(entry, seen);
  seen.delete(value);
}

function objectInput(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setText(envelope: PiActionEnvelope, key: keyof PiActionEnvelope, value: unknown): void {
  const text = cleanString(value);
  if (text !== "") Object.assign(envelope, { [key]: text });
}

function requireText(value: unknown, name: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${name} is required`);
  return text;
}

function normalizeIssueID(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function booleanInput(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  const text = cleanString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function riskLevelInput(value: unknown): PiRiskLevel | undefined {
  const text = cleanString(value);
  return text === "low" || text === "medium" || text === "high" ? text : undefined;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
