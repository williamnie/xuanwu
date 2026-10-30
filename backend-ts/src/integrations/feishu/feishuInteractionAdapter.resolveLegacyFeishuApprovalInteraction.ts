import { createHash } from "node:crypto";
import { getPiAction } from "../../db/repositories/pi.ts";
import { getPiApprovalRequest } from "../../db/repositories/pi/approvalRequests.ts";
import { getFeishuPendingProjectSelection } from "../../db/repositories/feishuProjectSelection.ts";
import type { FeishuApprovalAction } from "./feishuApprovalCards.ts";
import type { FeishuPiActionCardAction } from "./feishuPiActionCards.ts";
import type { FeishuProjectSelectionAction } from "./feishuProjectSelection.ts";
import { type ImInteractionHandleResult } from "../im/imInteractionService.ts";
import { cleanString } from "../../util/values.ts";
import type { FeishuImInteractionContext } from "./feishuInteractionAdapter.model.ts";
import { hasLegacyBinding, approvalActionID, resolveLegacyFeishuInteraction, legacyActor, compatibilityExpiry } from "./feishuInteractionAdapter.resolveFeishuImInteraction.ts";

/**
 * Adopt a pre-cutover Feishu approval card into the generic interaction
 * service. The callback only selects one server-declared action; its business
 * reference, actor, scope and compatibility expiry stay in the binding.
 */
export async function resolveLegacyFeishuApprovalInteraction(
  context: FeishuImInteractionContext,
  action: FeishuApprovalAction
): Promise<ImInteractionHandleResult> {
  const request = getPiApprovalRequest(context.database, action.requestID);
  if (!request) throw new Error("pi approval request not found");
  if (["approved", "rejected", "cancelled", "expired"].includes(request.status) &&
    !hasLegacyBinding(context.database, "approval", action.requestID)) {
    throw new Error("pi approval request is not pending");
  }
  const actions = [
    { action_id: "approve", value: "approve:turn" },
    { action_id: "approve_session", value: "approve_session:session" },
    { action_id: "deny", value: "deny:turn" },
    { action_id: "defer", value: "defer:turn" }
  ];
  const actionID = approvalActionID(action);
  if (!actions.some((item) => item.action_id === actionID)) return { reason: "action_mismatch" };
  return resolveLegacyFeishuInteraction(context, {
    actionID,
    actionKind: "approval",
    actionRef: `pi_approval_requests:${action.requestID}`,
    actions,
    actor: legacyActor(action),
    bindingActor: legacyActor(action),
    bindingScopeKey: cleanString(action.chatID),
    businessRef: action.requestID,
    chatID: cleanString(action.chatID),
    eventID: cleanString(action.actionID),
    expiresAt: compatibilityExpiry(request.created_at),
    messageID: ""
  });
}

/** Adopt a pre-cutover PI action card into the generic interaction service. */
export async function resolveLegacyFeishuPiActionInteraction(
  context: FeishuImInteractionContext,
  action: FeishuPiActionCardAction
): Promise<ImInteractionHandleResult> {
  const record = getPiAction(context.database, action.piActionID);
  if (!record) throw new Error("PI action not found");
  if (record.status !== "pending" && !hasLegacyBinding(context.database, "pi_action", action.piActionID)) {
    throw new Error("PI action is not pending");
  }
  const actions = [
    { action_id: "approve", value: "approve" },
    { action_id: "approve_always", value: "approve_always" },
    { action_id: "reject", value: "reject" },
    { action_id: "request_changes", value: "request_changes" },
    { action_id: "snooze", value: "snooze:30" }
  ];
  return resolveLegacyFeishuInteraction(context, {
    actionID: action.decision,
    actionKind: "pi_action",
    actionRef: `pi_actions:${action.piActionID}`,
    actions,
    actor: legacyActor(action),
    bindingActor: legacyActor(action),
    bindingScopeKey: cleanString(action.chatID),
    businessRef: action.piActionID,
    chatID: cleanString(action.chatID),
    eventID: cleanString(action.actionID),
    expiresAt: compatibilityExpiry(record.created_at),
    messageID: ""
  });
}

/** Adopt a pre-cutover project-selection card using authoritative candidates. */
export async function resolveLegacyFeishuProjectSelectionInteraction(
  context: FeishuImInteractionContext,
  action: FeishuProjectSelectionAction
): Promise<ImInteractionHandleResult> {
  const selection = getFeishuPendingProjectSelection(context.database, action.selection_id);
  if (!selection) throw new Error("project selection not found");
  if (selection.status !== "pending" && !hasLegacyBinding(context.database, "project_selection", action.selection_id)) {
    throw new Error("project selection is not pending");
  }
  const actions = selection.candidates.map((projectID) => ({
    action_id: legacyProjectActionID(projectID),
    value: projectID
  }));
  return resolveLegacyFeishuInteraction(context, {
    actionID: legacyProjectActionID(action.project_id),
    actionKind: "project_selection",
    actionRef: `im_project_selections:${action.selection_id}`,
    actions,
    actor: { id: action.user_id, openId: action.user_open_id },
    bindingActor: { id: selection.user_id, openId: selection.user_open_id },
    bindingScopeKey: selection.chat_id,
    businessRef: action.selection_id,
    chatID: action.chat_id,
    eventID: cleanString(action.action_id),
    expiresAt: selection.expires_at,
    messageID: action.message_id
  });
}

export function legacyProjectActionID(projectID: string): string {
  return `project:${createHash("sha256").update(projectID).digest("base64url").slice(0, 16)}`;
}
