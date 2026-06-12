import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiAction,
  createPiActionEvent,
  getPiAction,
  updatePiAction,
  type PiAction
} from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";

export { classifyPiActionRisk, decidePiAuthorization, gatePiActionEnvelope } from "./actionGate.ts";
import {
  gatePiActionEnvelope,
  type PiActionDecision,
  type PiActionEnvelope,
  type PiGateDecision,
  type PiGatePolicy
} from "./actionGate.ts";
import { normalizePiActionEnvelope } from "./actionEnvelope.ts";

export type PiActionRequest = {
  actionType: string;
  conversationID?: string;
  goalID?: string;
  goal_id?: string;
  issueID?: number;
  payload: Record<string, unknown>;
  projectID?: string;
  rationale?: string;
  riskOverride?: { requiresConfirmation?: boolean; riskLevel?: PiActionEnvelope["risk_level"] };
};

export type PiActionContext = {
  authorization?: PiGatePolicy;
  bus?: EventBus;
  conversationID?: string;
  delegationID?: string;
  heartbeatID?: string;
  source?: string;
};

type SafeActionInput = PiActionRequest & { execute: () => unknown; resultForAudit?: (result: unknown) => unknown };
type AuditInput = {
  actor?: string;
  decision?: string;
  error?: string;
  payload?: unknown;
  reason?: string;
  result?: unknown;
};

export function executeSafePiAction(db: RunnerDatabase, context: PiActionContext, input: SafeActionInput) {
  const gated = createGatedPiAction(db, context, input);
  if (gated.decision.decision !== "execute") return actionResultFromRecord(gated.action);
  return executePiActionWithAudit(db, context, gated.action, input.execute, input.resultForAudit);
}

export function createPendingPiAction(
  db: RunnerDatabase,
  context: PiActionContext,
  input: PiActionRequest,
  execute?: () => unknown
) {
  const gated = createGatedPiAction(db, context, input);
  if (gated.decision.decision === "execute" && execute) {
    executePiActionWithAudit(db, context, gated.action, execute);
    return actionResultFromRecord(requireStoredPiAction(db, gated.action.id));
  }
  return actionResultFromRecord(gated.action);
}

export function recordPiActionAuditEvent(
  db: RunnerDatabase,
  action: PiAction,
  eventType: string,
  input: AuditInput = {}
): void {
  createPiActionEvent(db, {
    action_id: action.id,
    actor: cleanString(input.actor),
    conversation_id: action.conversation_id,
    decision: cleanString(input.decision),
    delegation_id: action.delegation_id,
    error: cleanString(input.error),
    event_type: eventType,
    heartbeat_id: action.heartbeat_id,
    issue_id: action.issue_id,
    payload_json: JSON.stringify(input.payload ?? {}),
    project_id: action.project_id,
    reason: cleanString(input.reason),
    result_json: JSON.stringify(input.result ?? {})
  });
}

function createGatedPiAction(
  db: RunnerDatabase,
  context: PiActionContext,
  input: PiActionRequest
): { action: PiAction; decision: PiGateDecision } {
  const envelope = actionEnvelope(input, context);
  const candidate = createPiActionRecord(db, context, input, envelope);
  recordPiActionAuditEvent(db, candidate, "candidate", { actor: "pi", payload: envelope });
  const decision = gatePiActionEnvelope(envelope, context.authorization);
  return { action: persistGateDecision(db, context, candidate, decision), decision };
}

function persistGateDecision(
  db: RunnerDatabase,
  context: PiActionContext,
  action: PiAction,
  decision: PiGateDecision
): PiAction {
  const nextStatus = gateStatus(decision.decision);
  const result = { ...actionResult(action.id, { ...action, status: nextStatus }), decision: decision.decision };
  const next = updatePiAction(db, action.id, {
    gate_decision: decision.decision,
    gate_reason: decision.reason,
    result_json: JSON.stringify(result),
    status: nextStatus
  });
  recordPiActionAuditEvent(db, next, "gate_decision", {
    actor: "gate", decision: decision.decision, reason: decision.reason, result
  });
  if (decision.decision === "ask") recordPendingApproval(db, context, next, decision.reason);
  publishGateEvent(context.bus, decision.decision, next);
  return next;
}

function recordPendingApproval(
  db: RunnerDatabase,
  context: PiActionContext,
  action: PiAction,
  reason: string
): void {
  recordPiActionAuditEvent(db, action, "pending_approval", { actor: "gate", decision: "ask", reason });
  publishPiActionEvent(context.bus, "pi.action_pending", action);
}

function executePiActionWithAudit(
  db: RunnerDatabase,
  context: PiActionContext,
  action: PiAction,
  execute: () => unknown,
  resultForAudit: (result: unknown) => unknown = identity
) {
  const executing = updatePiAction(db, action.id, { status: "executing" });
  recordPiActionAuditEvent(db, executing, "execution_started", { actor: "gate", decision: "execute" });
  publishPiActionEvent(context.bus, "pi.action_executing", executing);
  try {
    const result = execute();
    const auditResult = resultForAudit(result);
    const completed = updatePiAction(db, action.id, { result_json: JSON.stringify(auditResult ?? null), status: "completed" });
    recordPiActionAuditEvent(db, completed, "execution_result", { actor: "executor", result: auditResult });
    publishPiActionEvent(context.bus, "pi.action_completed", completed);
    return result;
  } catch (error) {
    const failed = updatePiAction(db, action.id, { result_json: JSON.stringify({ error: safeError(error) }), status: "failed" });
    recordPiActionAuditEvent(db, failed, "execution_error", { actor: "executor", error: safeError(error) });
    publishPiActionEvent(context.bus, "pi.action_failed", failed);
    throw error;
  }
}

function createPiActionRecord(
  db: RunnerDatabase,
  context: PiActionContext,
  input: PiActionRequest,
  envelope: PiActionEnvelope
): PiAction {
  return createPiAction(db, {
    id: crypto.randomUUID(),
    action_type: envelope.action_type,
    conversation_id: cleanString(input.conversationID) || cleanString(context.conversationID),
    delegation_id: cleanString(envelope.delegation_id),
    heartbeat_id: cleanString(envelope.heartbeat_id),
    issue_id: envelope.issue_id ?? 0,
    payload_json: JSON.stringify(envelope.payload),
    project_id: cleanString(envelope.project_id),
    rationale: cleanString(envelope.rationale),
    requires_confirmation: envelope.requires_confirmation ? 1 : 0,
    risk_level: envelope.risk_level,
    source: envelope.source,
    status: "candidate"
  });
}

function actionEnvelope(
  input: PiActionRequest,
  context: PiActionContext
): PiActionEnvelope {
  return normalizePiActionEnvelope({
    action_type: input.actionType,
    delegation_id: cleanString(context.delegationID),
    goal_id: cleanString(input.goalID ?? input.goal_id),
    heartbeat_id: cleanString(context.heartbeatID),
    issue_id: input.issueID ?? 0,
    payload: input.payload,
    project_id: cleanString(input.projectID),
    rationale: cleanString(input.rationale),
    requires_confirmation: input.riskOverride?.requiresConfirmation,
    risk_level: input.riskOverride?.riskLevel,
    source: cleanString(context.source) || "pi_tool"
  });
}

function requireStoredPiAction(db: RunnerDatabase, id: string): PiAction {
  const action = getPiAction(db, id);
  if (!action) throw new Error("PI action missing after execution");
  return action;
}

function actionResult(id: string, action: Pick<PiAction, "action_type" | "issue_id" | "requires_confirmation" | "risk_level" | "status">) {
  return {
    action_id: id,
    action_type: action.action_type,
    issue_id: action.issue_id,
    requires_confirmation: action.requires_confirmation === 1,
    risk_level: action.risk_level,
    status: action.status
  };
}

function actionResultFromRecord(action: PiAction) {
  return {
    ...actionResult(action.id, action),
    decision: action.gate_decision,
    ...completedResult(action)
  };
}

function completedResult(action: PiAction): { result?: unknown } {
  if (action.status !== "completed") return {};
  try {
    return { result: JSON.parse(action.result_json || "null") as unknown };
  } catch {
    return {};
  }
}

function gateStatus(decision: PiActionDecision): string {
  if (decision === "execute") return "approved";
  if (decision === "ask") return "pending";
  if (decision === "snooze") return "snoozed";
  return "denied";
}

function publishGateEvent(bus: EventBus | undefined, decision: PiActionDecision, action: PiAction): void {
  if (decision === "deny") publishPiActionEvent(bus, "pi.action_denied", action);
  if (decision === "snooze") publishPiActionEvent(bus, "pi.action_snoozed", action);
}

export function publishPiActionEvent(bus: EventBus | undefined, type: string, action: PiAction): void {
  bus?.publish(piActionEvent(type, action));
}

function piActionEvent(type: string, action: PiAction): AppEvent {
  return {
    type,
    conversationId: action.conversation_id,
    issueId: action.issue_id || undefined,
    projectId: action.project_id,
    payload: JSON.stringify({
      action_id: action.id,
      action_type: action.action_type,
      decision: action.gate_decision,
      requires_confirmation: action.requires_confirmation === 1,
      risk_level: action.risk_level,
      status: action.status
    }),
    created_at: action.updated_at
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "action failed";
}

function identity(value: unknown): unknown {
  return value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
