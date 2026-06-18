import type { RunnerDatabase } from "../db/database.ts";
import {
  claimPiGuardianDecisionLease,
  getPiGuardianDecision,
  listPiGuardianDecisions,
  transitionPiGuardianDecisionState,
  type PiGuardianDecision
} from "../db/repositories/pi.ts";
import {
  acquireGuardianActionLease,
  actionLeaseTtlMs,
  createPendingPiAction,
  type PiActionRequest
} from "./actionEngine.ts";
import type { PiGatePolicy } from "./actionGate.ts";
import { recoveryLimitDecision } from "./actionGateRecovery.ts";

type ActionExecutionSummary = {
  leases_acquired: number;
  lease_skipped: number;
};

export function executeDecisionActions(
  db: RunnerDatabase,
  decision: PiGuardianDecision | null,
  now: Date,
  summary: ActionExecutionSummary
): void {
  if (!decision || decision.state !== "proposed") return;
  const requests = actionRequestsFromDecision(decision);
  if (requests.length === 0) return;
  if (decision.cooldown_until !== "" && decision.cooldown_until > iso(now)) return;
  const leasedDecision = claimDecisionLease(db, decision, requests, now);
  if (!leasedDecision) {
    skipHeldDecision(db, decision.id, summary);
    return;
  }
  executeLeasedRequests(db, { decision, leasedDecision, now, requests, summary });
}

export function executeReadyDecisionActions(
  db: RunnerDatabase,
  now: Date,
  summary: ActionExecutionSummary
): void {
  for (const decision of listPiGuardianDecisions(db, { state: "proposed" })) {
    executeDecisionActions(db, decision, now, summary);
  }
}

function claimDecisionLease(
  db: RunnerDatabase,
  decision: PiGuardianDecision,
  requests: PiActionRequest[],
  now: Date
): PiGuardianDecision | null {
  return claimPiGuardianDecisionLease(db, decision.id, {
    now,
    owner: guardianOwner(),
    ttlMs: Math.max(...requests.map((request) => actionLeaseTtlMs(request.actionType)))
  });
}

function executeLeasedRequests(
  db: RunnerDatabase,
  input: {
    decision: PiGuardianDecision;
    leasedDecision: PiGuardianDecision;
    now: Date;
    requests: PiActionRequest[];
    summary: ActionExecutionSummary;
  }
): void {
  const leasedState = getPiGuardianDecision(db, input.leasedDecision.id);
  for (const request of input.requests) {
    if (!executeOneRequest(db, input.decision, input.leasedDecision, request, input.now, input.summary)) return;
  }
  const latest = getPiGuardianDecision(db, input.leasedDecision.id);
  if (!latest || latest.state !== (leasedState?.state ?? input.leasedDecision.state)) return;
  transitionPiGuardianDecisionState(db, input.leasedDecision.id, { to: "completed" });
}

function executeOneRequest(
  db: RunnerDatabase,
  decision: PiGuardianDecision,
  leasedDecision: PiGuardianDecision,
  request: PiActionRequest,
  now: Date,
  summary: ActionExecutionSummary
): boolean {
  const lease = acquireGuardianActionLease(db, {
    actionType: request.actionType,
    idempotencyKey: request.idempotencyKey || guardianActionID(decision, request),
    issueID: request.issueID,
    now,
    owner: guardianOwner(),
    projectID: request.projectID,
    ttlMs: actionLeaseTtlMs(request.actionType)
  });
  if (lease.status === "held") return skipHeldDecision(db, decision.id, summary);
  if (lease.status === "idempotent_replay") return true;
  summary.leases_acquired += 1;
  request = applyRecoveryGateOverride(request, now);
  createPendingPiAction(db, guardianContext(leasedDecision, request, now), {
    ...request,
    idempotencyKey: lease.idempotency_key,
    payload: { ...request.payload, lease_expires_at: lease.until }
  });
  return true;
}

function applyRecoveryGateOverride(request: PiActionRequest, now: Date): PiActionRequest {
  const policy = recoveryGatePolicy(request.authorization, now);
  if (!policy) return request;
  const decision = recoveryLimitDecision(actionEnvelopeForRecoveryGate(request), policy);
  if (!decision) return request;
  return { ...request, authorization: policy };
}

function recoveryGatePolicy(policy: PiGatePolicy | undefined, now: Date): PiGatePolicy | undefined {
  if (!policy) return undefined;
  const record = policy as Record<string, unknown>;
  const gate = objectPayload(record.recovery_gate);
  const budget = numberValue(gate.budget_remaining ?? record.budget_remaining);
  const cooldown = cleanString(gate.cooldown_until ?? record.cooldown_until);
  if (budget === undefined && cooldown === "") return undefined;
  return { budget_remaining: budget, cooldown_until: cooldown, now: iso(now) } as PiGatePolicy;
}

function actionEnvelopeForRecoveryGate(request: PiActionRequest) {
  return {
    action_type: request.actionType,
    issue_id: request.issueID,
    payload: request.payload,
    project_id: request.projectID,
    requires_confirmation: false,
    risk_level: "low",
    source: "pi_guardian_orchestrator"
  } as const;
}

function guardianContext(decision: PiGuardianDecision, request: PiActionRequest, now: Date) {
  return {
    authorization: authorizationAt(request.authorization, now),
    guardianDecisionID: decision.id,
    legacyBypassReason: "",
    source: "pi_guardian_orchestrator"
  };
}

function skipHeldDecision(db: RunnerDatabase, id: string, summary: ActionExecutionSummary): false {
  skipDecisionIfActive(db, id, { rationale: "lease_held" });
  summary.lease_skipped += 1;
  return false;
}

function skipDecisionIfActive(
  db: RunnerDatabase,
  id: string,
  input: { rationale: string }
): void {
  const decision = getPiGuardianDecision(db, id);
  if (!decision || ["completed", "failed", "skipped", "superseded"].includes(decision.state)) return;
  transitionPiGuardianDecisionState(db, id, { rationale: input.rationale, to: "skipped" });
}

function actionRequestsFromDecision(decision: PiGuardianDecision): PiActionRequest[] {
  return jsonArray(decision.actions_json)
    .map((item) => actionRequestFromPayload(decision, item))
    .filter((item): item is PiActionRequest => item !== null);
}

function actionRequestFromPayload(decision: PiGuardianDecision, item: Record<string, unknown>): PiActionRequest | null {
  const actionType = cleanString(item.action_type);
  const payload = objectPayload(item.payload);
  if (actionType === "" || Object.keys(payload).length === 0) return null;
  const issueID = positiveNumber(item.issue_id) || positiveNumber(payload.issue_id) || decision.issue_id;
  return {
    actionType,
    authorization: authorizationPolicy(item),
    guardianDecisionID: decision.id,
    idempotencyKey: cleanString(item.idempotency_key),
    issueID: issueID > 0 ? issueID : undefined,
    payload: { ...payload, guardian_decision_id: decision.id, lease_expires_at: cleanString(item.lease_expires_at) },
    projectID: cleanString(item.project_id) || decision.project_id,
    rationale: cleanString(item.rationale) || decision.rationale,
    riskOverride: riskOverride(item)
  };
}

function guardianActionID(decision: PiGuardianDecision, request: PiActionRequest): string {
  return [
    "guardian_action",
    decision.id,
    request.actionType,
    cleanString(request.projectID) || "global",
    request.issueID ?? 0
  ].join(":");
}

function riskOverride(item: Record<string, unknown>): PiActionRequest["riskOverride"] | undefined {
  const riskLevel = cleanString(item.risk_level);
  const requiresConfirmation = booleanValue(item.requires_confirmation);
  if (!requiresConfirmation && riskLevel === "") return undefined;
  return {
    requiresConfirmation,
    riskLevel: riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" ? riskLevel : undefined
  };
}

function authorizationPolicy(item: Record<string, unknown>): PiGatePolicy | undefined {
  const gatePolicy = objectPayload(item.gate_policy);
  const authorization = Object.keys(gatePolicy).length > 0 ? gatePolicy : objectPayload(item.authorization);
  hydrateRedactedAuthorizedActions(authorization);
  return Object.keys(authorization).length > 0 ? authorization as PiGatePolicy : undefined;
}

function authorizationAt(policy: PiGatePolicy | undefined, now: Date): PiGatePolicy | undefined {
  return policy ? { ...policy, now: iso(now) } : undefined;
}

function hydrateRedactedAuthorizedActions(authorization: Record<string, unknown>): void {
  const allowed = stringArray(authorization.allowed_actions ?? authorization.allowedActions);
  if (allowed.length === 0) return;
  const current = authorization.authorizedActions;
  if (Array.isArray(current) && current.length > 0) return;
  authorization.authorizedActions = allowed.map((action_type) => ({ action_type }));
}

function guardianOwner(): string {
  return `guardian-orchestrator:${crypto.randomUUID()}`;
}

function jsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(objectPayload) : [];
  } catch {
    return [];
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  return text === "" ? [] : text.split(/\n|,/).map(cleanString).filter(Boolean);
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  return undefined;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
