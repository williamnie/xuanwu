import type { RunnerDatabase } from "../../db/database.ts";
import { getPiAction, updatePiAction, type PiAction, type PiActionInput } from "../../db/repositories/pi.ts";
import { publishPiActionEvent, recordPiActionAuditEvent } from "../../pi/actions/actionEngine.ts";
import { HttpError } from "../errors.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import { readMcpCapability, readMcpServer } from "../../mcp/registry.ts";
import { mcpCapabilityFingerprint } from "../../mcp/approvalPolicy.ts";
import { evaluatePiActionFreshness } from "../../pi/actions/actionFreshness.ts";
import { cleanString } from "../../util/values.ts";
import type { PiActionDecisionContext } from "./piActionDecision.model.ts";

export async function approveAction(context: PiActionDecisionContext, id: string, actorID: string): Promise<PiAction> {
  const action = requireCurrentApprovableAction(context.database, id);
  if (isTerminal(action) || action.status === "executing") return action;
  assertApprovableGate(action);
  assertCurrentMcpCapability(context.database, action);
  assertFreshPiAction(context, action, "approval");
  const approved = action.status === "approved" ? action : approvePendingAction(context, action, actorID);
  return await executeApprovedPiAction(context, approved.id);
}

export async function executeApprovedPiAction(context: PiActionDecisionContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isFinished(action)) return action;
  if (action.status === "executing") return action;
  if (action.status !== "approved") {
    throw new HttpError(400, "PI action must be approved before execute");
  }
  assertExecutableGate(action);
  assertFreshPiAction(context, action, "dispatch");
  const executing = writeExecutingAction(context, action);
  try {
    return completeAction(context, executing, await dispatchPiAction(context, executing));
  } catch (error) {
    const failed = writeAction(context, executing, "failed", { error: safeError(error) }, "pi.action_failed");
    recordPiActionAuditEvent(context.database, failed, "execution_error", { actor: "executor", error: safeError(error) });
    return failed;
  }
}

export function assertFreshPiAction(
  context: PiActionDecisionContext,
  action: PiAction,
  phase: "approval" | "dispatch"
): void {
  const freshness = approvalLeaseExpired(action)
    ? { fresh: false as const, reason: "approval_expired" }
    : evaluatePiActionFreshness(context.database, action);
  if (freshness.fresh) return;
  const reason = `${phase}:${freshness.reason}`;
  const rejected = writeAction(
    context,
    action,
    "rejected",
    { action_id: action.id, reason, status: "rejected" },
    "pi.action_rejected",
    { decided_by: "system:action_revalidation" }
  );
  recordPiActionAuditEvent(context.database, rejected, "approval_stale", {
    actor: rejected.decided_by,
    decision: "reject",
    reason,
    payload: freshness.supersededBy ? { superseded_by: freshness.supersededBy } : {}
  });
  throw new HttpError(409, `PI action is stale: ${freshness.reason}`);
}

export function approvalLeaseExpired(action: PiAction): boolean {
  if (action.lease_expires_at === "") return false;
  const expiresAt = Date.parse(action.lease_expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function completeAction(context: PiActionDecisionContext, action: PiAction, result: unknown): PiAction {
  const completed = writeAction(context, action, "completed", result ?? null, "pi.action_completed");
  recordPiActionAuditEvent(context.database, completed, "execution_result", { actor: "executor", result });
  return completed;
}

export function approvePendingAction(context: PiActionDecisionContext, action: PiAction, actorID: string): PiAction {
  const approved = writeAction(context, action, "approved", approvedResult(action), "pi.action_approved", {
    approved_by: actorID
  });
  recordPiActionAuditEvent(context.database, approved, "approval_decision", {
    actor: approved.approved_by || actorID, decision: "approve", reason: "user approved action"
  });
  return approved;
}

export function writeExecutingAction(context: PiActionDecisionContext, action: PiAction): PiAction {
  const executing = writeAction(context, action, "executing", statusResult(action, "executing"), "pi.action_executing");
  recordPiActionAuditEvent(context.database, executing, "execution_started", { actor: "gate", decision: "execute" });
  return executing;
}

export function writeAction(
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

export function approvedResult(action: PiAction): Record<string, unknown> {
  return { ...statusResult(action, "approved"), approved_at: new Date().toISOString() };
}

export function statusResult(action: PiAction, status: string): Record<string, unknown> {
  return { action_id: action.id, action_type: action.action_type, status };
}

export function requireAction(db: RunnerDatabase, id: string): PiAction {
  const action = getPiAction(db, id);
  if (!action) throw new HttpError(404, "资源不存在");
  return action;
}

export function requireCurrentApprovableAction(db: RunnerDatabase, id: string): PiAction {
  const action = requireAction(db, id);
  if (action.lease_expires_at === "") return action;
  const expiresAt = Date.parse(action.lease_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return action;
  if (action.status === "pending") {
    const expired = updatePiAction(db, action.id, {
      decided_by: "system:approval_ttl",
      result_json: JSON.stringify({ action_id: action.id, reason: "approval_ttl_expired", status: "rejected" }),
      status: "rejected"
    });
    recordPiActionAuditEvent(db, expired, "approval_expired", {
      actor: "system:approval_ttl",
      decision: "reject",
      reason: "PI action approval window expired"
    });
  }
  throw new HttpError(409, "PI action approval request expired");
}

export function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function assertCurrentMcpCapability(db: RunnerDatabase, action: PiAction): void {
  if (action.action_type !== "mcp.tool.call") return;
  const payload = parsePayload(action.payload_json);
  const proposedFingerprint = cleanString(payload.capability_fingerprint);
  if (proposedFingerprint === "") return;
  const capability = readMcpCapability(cleanString(payload.capability_id), { database: db });
  const server = capability ? readMcpServer(capability.server_id, { database: db }) : null;
  if (!capability || !server) throw new HttpError(409, "MCP capability is no longer enabled");
  if (mcpCapabilityFingerprint(server, capability) !== proposedFingerprint) {
    throw new HttpError(409, "MCP capability changed after approval was requested");
  }
}

export function assertApprovableGate(action: PiAction): void {
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

export function assertExecutableGate(action: PiAction): void {
  if (action.gate_decision === "deny") throw new HttpError(409, "PI action was denied by approval gate");
  if (action.gate_decision === "snooze") throw new HttpError(409, "PI action is snoozed by approval gate");
  if (action.gate_decision !== "ask" && action.gate_decision !== "execute") {
    throw new HttpError(409, "PI action must pass approval gate before execute");
  }
}

export function isFinished(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed";
}

export function isTerminal(action: PiAction): boolean {
  return isFinished(action) || action.status === "rejected";
}

export function actor(value: unknown): string {
  return cleanString(value) || "user";
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "PI action failed";
}
