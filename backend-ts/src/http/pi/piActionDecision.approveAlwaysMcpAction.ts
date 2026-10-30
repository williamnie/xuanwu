import { updatePiAction, type PiAction } from "../../db/repositories/pi.ts";
import { publishPiActionEvent, recordPiActionAuditEvent } from "../../pi/actions/actionEngine.ts";
import { HttpError } from "../errors.ts";
import { grantPiMcpCapabilityApproval } from "../../db/repositories/pi.ts";
import { readMcpCapability, readMcpServer } from "../../mcp/registry.ts";
import { mcpCapabilityFingerprint } from "../../mcp/approvalPolicy.ts";
import { getPiMcpCapability } from "../../db/repositories/piMcpCapabilities.ts";
import { cleanString } from "../../util/values.ts";
import type { PiActionDecisionContext, PiActionResolveInput } from "./piActionDecision.model.ts";
import { approveAction, actor, requireCurrentApprovableAction, isTerminal, assertApprovableGate, parsePayload, requireAction, writeAction, statusResult } from "./piActionDecision.assertFreshPiAction.ts";

export async function resolvePiActionDecision(
  context: PiActionDecisionContext,
  input: PiActionResolveInput
): Promise<PiAction> {
  if (input.decision === "approve") return approveAction(context, input.actionID, actor(input.actor));
  if (input.decision === "approve_always") {
    return approveAlwaysMcpAction(context, input.actionID, actor(input.actor), input.reason);
  }
  if (input.decision === "reject") return rejectAction(context, input.actionID, actor(input.actor), input.reason);
  if (input.decision === "request_changes") {
    return requestChangesAction(context, input.actionID, actor(input.actor), input.comment || input.reason);
  }
  return snoozeAction(context, input.actionID, actor(input.actor), input.snoozedUntil ?? "", input.reason);
}

export async function approveAlwaysMcpAction(
  context: PiActionDecisionContext,
  id: string,
  actorID: string,
  reason?: string
): Promise<PiAction> {
  const action = requireCurrentApprovableAction(context.database, id);
  if (isTerminal(action) || action.status === "executing") return action;
  if (action.action_type !== "mcp.tool.call") throw new HttpError(400, "approve_always only supports MCP tool calls");
  assertApprovableGate(action);
  if (action.project_id === "") throw new HttpError(409, "MCP persistent approval requires a project scope");
  const payload = parsePayload(action.payload_json);
  const capabilityID = cleanString(payload.capability_id);
  if (!getPiMcpCapability(context.database, capabilityID)) {
    throw new HttpError(409, "Persistent approval requires an installed MCP capability");
  }
  const capability = readMcpCapability(capabilityID, { database: context.database });
  const server = capability ? readMcpServer(capability.server_id, { database: context.database }) : null;
  if (!capability || !server) throw new HttpError(409, "MCP capability is no longer available");
  const fingerprint = mcpCapabilityFingerprint(server, capability);
  const proposedFingerprint = cleanString(payload.capability_fingerprint);
  if (proposedFingerprint !== "" && proposedFingerprint !== fingerprint) {
    throw new HttpError(409, "MCP capability changed after approval was requested");
  }
  const grant = grantPiMcpCapabilityApproval(context.database, {
    capabilityFingerprint: fingerprint,
    capabilityID,
    grantedBy: actorID,
    projectID: action.project_id,
    reason: cleanString(reason) || "user always allowed MCP capability for project"
  });
  recordPiActionAuditEvent(context.database, action, "mcp_approval_grant_created", {
    actor: actorID,
    decision: "approve_always",
    payload: { capability_id: capabilityID, grant_id: grant.id, project_id: action.project_id }
  });
  return await approveAction(context, id, actorID);
}

export function rejectAction(context: PiActionDecisionContext, id: string, actorID: string, reason?: string): PiAction {
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

export function requestChangesAction(
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

export function snoozeAction(
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

export function assertSnoozedUntil(until: string): void {
  if (until === "") throw new HttpError(400, "snoozed_until 不能为空");
  if (!Number.isFinite(Date.parse(until))) throw new HttpError(400, "snoozed_until 必须是合法时间");
}

export function isExecuted(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed" || action.status === "executing";
}
