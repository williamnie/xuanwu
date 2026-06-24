import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiAction,
  updatePiAction,
  type PiAction,
  type PiActionInput
} from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { publishPiActionEvent, recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import { HttpError } from "./errors.ts";
import { dispatchPiAction, type ProjectLoopStarter } from "./piActionDispatch.ts";

export type PiActionDecisionContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export type PiActionResolveDecision = "approve" | "reject" | "request_changes" | "snooze";

export type PiActionResolveInput = {
  actionID: string;
  actor?: string;
  comment?: string;
  decision: PiActionResolveDecision;
  reason?: string;
  snoozedUntil?: string;
};

export async function resolvePiActionDecision(
  context: PiActionDecisionContext,
  input: PiActionResolveInput
): Promise<PiAction> {
  if (input.decision === "approve") return approveAction(context, input.actionID, actor(input.actor));
  if (input.decision === "reject") return rejectAction(context, input.actionID, actor(input.actor), input.reason);
  if (input.decision === "request_changes") {
    return requestChangesAction(context, input.actionID, actor(input.actor), input.comment || input.reason);
  }
  return snoozeAction(context, input.actionID, actor(input.actor), input.snoozedUntil ?? "", input.reason);
}

async function approveAction(context: PiActionDecisionContext, id: string, actorID: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isTerminal(action) || action.status === "executing") return action;
  assertApprovableGate(action);
  const approved = action.status === "approved" ? action : approvePendingAction(context, action, actorID);
  return await executeApprovedPiAction(context, approved.id);
}

function rejectAction(context: PiActionDecisionContext, id: string, actorID: string, reason?: string): PiAction {
  const action = requireAction(context.database, id);
  if (action.status === "rejected" || isExecuted(action)) return action;
  const rejected = writeAction(context, action, "rejected", statusResult(action, "rejected"), "pi.action_rejected", {
    decided_by: actorID
  });
  recordPiActionAuditEvent(context.database, rejected, "approval_decision", {
    actor: rejected.decided_by, decision: "reject", reason: cleanString(reason) || "user rejected action"
  });
  return rejected;
}

function requestChangesAction(
  context: PiActionDecisionContext,
  id: string,
  actorID: string,
  comment?: string
): PiAction {
  const action = requireAction(context.database, id);
  if (isExecuted(action)) return action;
  const requested = cleanString(comment);
  const next = updatePiAction(context.database, action.id, {
    decided_by: actorID,
    requested_changes: requested,
    result_json: JSON.stringify({ ...statusResult(action, "changes_requested"), requested_changes: requested }),
    status: "changes_requested"
  });
  recordPiActionAuditEvent(context.database, next, "approval_decision", {
    actor: next.decided_by, decision: "request_changes", reason: requested
  });
  publishPiActionEvent(context.bus, "pi.action_changes_requested", next);
  return next;
}

function snoozeAction(
  context: PiActionDecisionContext,
  id: string,
  actorID: string,
  until: string,
  reason?: string
): PiAction {
  const action = requireAction(context.database, id);
  if (isExecuted(action)) return action;
  const snoozedUntil = cleanString(until);
  assertSnoozedUntil(snoozedUntil);
  const snoozeReason = cleanString(reason) || "user snoozed action";
  const next = updatePiAction(context.database, action.id, {
    decided_by: actorID,
    gate_decision: "snooze",
    result_json: JSON.stringify({ ...statusResult(action, "snoozed"), snoozed_until: snoozedUntil }),
    snoozed_until: snoozedUntil,
    status: "snoozed"
  });
  recordPiActionAuditEvent(context.database, next, "approval_decision", {
    actor: next.decided_by, decision: "snooze", reason: snoozeReason
  });
  publishPiActionEvent(context.bus, "pi.action_snoozed", next);
  return next;
}

export async function executeApprovedPiAction(context: PiActionDecisionContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isFinished(action)) return action;
  if (action.status === "executing") return action;
  if (action.status !== "approved") {
    throw new HttpError(400, "PI action must be approved before execute");
  }
  assertExecutableGate(action);
  const executing = writeExecutingAction(context, action);
  try {
    return completeAction(context, executing, await dispatchPiAction(context, executing));
  } catch (error) {
    const failed = writeAction(context, executing, "failed", { error: safeError(error) }, "pi.action_failed");
    recordPiActionAuditEvent(context.database, failed, "execution_error", { actor: "executor", error: safeError(error) });
    return failed;
  }
}

function completeAction(context: PiActionDecisionContext, action: PiAction, result: unknown): PiAction {
  const completed = writeAction(context, action, "completed", result ?? null, "pi.action_completed");
  recordPiActionAuditEvent(context.database, completed, "execution_result", { actor: "executor", result });
  return completed;
}

function approvePendingAction(context: PiActionDecisionContext, action: PiAction, actorID: string): PiAction {
  const approved = writeAction(context, action, "approved", approvedResult(action), "pi.action_approved", {
    approved_by: actorID
  });
  recordPiActionAuditEvent(context.database, approved, "approval_decision", {
    actor: approved.approved_by || actorID, decision: "approve", reason: "user approved action"
  });
  return approved;
}

function writeExecutingAction(context: PiActionDecisionContext, action: PiAction): PiAction {
  const executing = writeAction(context, action, "executing", statusResult(action, "executing"), "pi.action_executing");
  recordPiActionAuditEvent(context.database, executing, "execution_started", { actor: "gate", decision: "execute" });
  return executing;
}

function writeAction(
  context: PiActionDecisionContext,
  action: PiAction,
  status: string,
  result: unknown,
  eventType?: string,
  patch: PiActionInput = {}
): PiAction {
  const next = updatePiAction(context.database, action.id, { ...patch, status, result_json: JSON.stringify(result) });
  if (eventType) publishPiActionEvent(context.bus, eventType, next);
  return next;
}

function approvedResult(action: PiAction): Record<string, unknown> {
  return { ...statusResult(action, "approved"), approved_at: new Date().toISOString() };
}

function statusResult(action: PiAction, status: string): Record<string, unknown> {
  return { action_id: action.id, action_type: action.action_type, status };
}

function requireAction(db: RunnerDatabase, id: string): PiAction {
  const action = getPiAction(db, id);
  if (!action) throw new HttpError(404, "资源不存在");
  return action;
}

function assertApprovableGate(action: PiAction): void {
  if (action.status === "denied" || action.gate_decision === "deny") {
    throw new HttpError(409, "PI action was denied by approval gate");
  }
  if (action.status !== "pending" && action.status !== "approved") {
    throw new HttpError(409, `PI action cannot be approved from status ${action.status}`);
  }
  if (action.gate_decision !== "ask" && action.gate_decision !== "execute") {
    throw new HttpError(409, "PI action must pass approval gate before approve");
  }
}

function assertExecutableGate(action: PiAction): void {
  if (action.gate_decision === "deny") throw new HttpError(409, "PI action was denied by approval gate");
  if (action.gate_decision === "snooze") throw new HttpError(409, "PI action is snoozed by approval gate");
  if (action.gate_decision !== "ask" && action.gate_decision !== "execute") {
    throw new HttpError(409, "PI action must pass approval gate before execute");
  }
}

function assertSnoozedUntil(until: string): void {
  if (until === "") throw new HttpError(400, "snoozed_until 不能为空");
  if (!Number.isFinite(Date.parse(until))) throw new HttpError(400, "snoozed_until 必须是合法时间");
}

function isFinished(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed";
}

function isTerminal(action: PiAction): boolean {
  return isFinished(action) || action.status === "rejected";
}

function isExecuted(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed" || action.status === "executing";
}

function actor(value: unknown): string {
  return cleanString(value) || "user";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "PI action failed";
}
