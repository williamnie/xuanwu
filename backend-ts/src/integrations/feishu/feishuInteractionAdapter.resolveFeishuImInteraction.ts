import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { createImInteractionBinding, getImInteractionBinding, type ImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { resolvePiApprovalRequestFromFeishu } from "./feishuApprovalRequests.ts";
import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { resolvePiActionFromFeishu } from "./feishuPiActionResolve.ts";
import type { FeishuApprovalAction } from "./feishuApprovalCards.ts";
import { createImInteractionService, type ImInteractionHandleResult } from "../im/imInteractionService.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import type { FeishuImInteraction, FeishuImInteractionContext, LegacyInteractionInput } from "./feishuInteractionAdapter.model.ts";

/** Normalize only the post-cutover opaque callback shape. */
export function normalizeFeishuImInteraction(raw: unknown): FeishuImInteraction | null {
  const root = objectValue(raw);
  const nestedEvent = objectValue(root.event);
  const event = Object.keys(nestedEvent).length > 0 ? nestedEvent : root;
  if (cleanString(objectValue(root.header).event_type || root.event_type) !== "card.action.trigger") return null;
  const action = objectValue(event.action);
  const value = objectValue(action.value);
  if (cleanString(value.action) !== "xuanwu_im_interaction") return null;
  const interactionID = cleanString(value.interaction_id);
  const actionID = cleanString(value.action_id);
  const revision = positiveInteger(value.revision);
  const context = objectValue(event.context);
  const operator = objectValue(event.operator);
  const operatorID = Object.keys(objectValue(operator.operator_id)).length > 0
    ? objectValue(operator.operator_id)
    : operator;
  const chatID = cleanString(context.open_chat_id || context.chat_id);
  const userID = cleanString(operatorID.user_id || operatorID.userId);
  const userOpenID = cleanString(operatorID.open_id || operatorID.openId);
  if (interactionID === "" || actionID === "" || revision === 0 || chatID === "" || (userID === "" && userOpenID === "")) return null;
  return {
    callback: {
      actionId: actionID,
      actor: { ...(userID ? { id: userID } : {}), ...(userOpenID ? { openId: userOpenID } : {}) },
      connectorId: "feishu",
      eventId: cleanString(objectValue(root.header).event_id || root.event_id),
      interactionId: interactionID,
      revision,
      scopeKey: chatID
    },
    chatID,
    messageID: cleanString(context.open_message_id || context.message_id),
    userID,
    userOpenID
  };
}

export async function resolveFeishuImInteraction(
  context: FeishuImInteractionContext,
  input: FeishuImInteraction
): Promise<ImInteractionHandleResult> {
  if (!callbackAllowed(context.config, input)) return { reason: "actor_mismatch" };
  const service = createImInteractionService({
    database: context.database,
    resolvers: {
      approval: async ({ action, binding }) => {
        const [decision, scope = "turn"] = action.value.split(":", 2);
        return resolvePiApprovalRequestFromFeishu(context.database, {
          chatID: input.chatID,
          decision,
          providers: context.providers,
          requestID: refID(binding.action_ref, "pi_approval_requests"),
          scope,
          userID: input.userID,
          userOpenID: input.userOpenID
        });
      },
      piAction: async ({ action, binding }) => {
        const [decision, minutes] = action.value.split(":", 2);
        return resolvePiActionFromFeishu({ ...context, database: context.database }, {
          actionID: input.callback.eventId,
          chatID: input.chatID,
          decision: decision as "approve" | "approve_always" | "reject" | "request_changes" | "snooze",
          piActionID: refID(binding.action_ref, "pi_actions"),
          snoozeMinutes: positiveInteger(minutes) || undefined,
          userID: input.userID,
          userOpenID: input.userOpenID
        });
      },
      projectSelection: context.agentBridge ? async ({ action, binding }) => {
        const result = await context.agentBridge!.resolveProjectSelectionAction({
          action_id: input.callback.eventId ?? "",
          chat_id: input.chatID,
          message_id: input.messageID,
          project_id: action.value,
          selection_id: refID(binding.action_ref, "im_project_selections"),
          user_id: input.userID,
          user_open_id: input.userOpenID
        });
        return { ok: result.replied, status: result.reason };
      } : undefined
    }
  });
  return service.handle(input.callback);
}

export async function resolveLegacyFeishuInteraction(
  context: FeishuImInteractionContext,
  input: LegacyInteractionInput
): Promise<ImInteractionHandleResult> {
  const interactionID = legacyInteractionID(input.actionKind, input.businessRef);
  const binding = adoptLegacyBinding(context.database, interactionID, input);
  return resolveFeishuImInteraction(context, {
    callback: {
      actionId: input.actionID,
      actor: input.actor,
      connectorId: "feishu",
      eventId: input.eventID,
      interactionId: binding.interaction_id,
      revision: binding.revision,
      scopeKey: input.chatID
    },
    chatID: input.chatID,
    messageID: input.messageID,
    userID: cleanString(input.actor.id),
    userOpenID: cleanString(input.actor.openId)
  });
}

export function adoptLegacyBinding(
  database: RunnerDatabase,
  interactionID: string,
  input: LegacyInteractionInput
): ImInteractionBinding {
  const existing = getImInteractionBinding(database, interactionID);
  if (existing) return existing;
  try {
    return createImInteractionBinding(database, {
      actionKind: input.actionKind,
      actionRef: input.actionRef,
      actions: input.actions,
      actor: input.bindingActor,
      connectorId: "feishu",
      expiresAt: input.expiresAt,
      interactionId: interactionID,
      scopeKey: input.bindingScopeKey,
      sourceMessageId: input.messageID
    });
  } catch (error) {
    const raced = getImInteractionBinding(database, interactionID);
    if (raced) return raced;
    throw error;
  }
}

export function legacyInteractionID(kind: string, businessRef: string): string {
  return createHash("sha256").update(`feishu:legacy:${kind}:${businessRef}`).digest("base64url").slice(0, 32);
}

export function hasLegacyBinding(database: RunnerDatabase, kind: string, businessRef: string): boolean {
  return getImInteractionBinding(database, legacyInteractionID(kind, businessRef)) !== null;
}

export function approvalActionID(action: FeishuApprovalAction): string {
  if (action.decision === "approve" && cleanString(action.scope || "turn") === "turn") return "approve";
  if (action.decision === "approve_session" && cleanString(action.scope || "session") === "session") return "approve_session";
  if (action.decision === "deny" && cleanString(action.scope || "turn") === "turn") return "deny";
  if (action.decision === "defer" && cleanString(action.scope || "turn") === "turn") return "defer";
  return "";
}

export function legacyActor(input: { userID?: string; userOpenID?: string }): { id?: string; openId?: string } {
  return { ...(cleanString(input.userID) ? { id: cleanString(input.userID) } : {}), ...(cleanString(input.userOpenID) ? { openId: cleanString(input.userOpenID) } : {}) };
}

export function compatibilityExpiry(createdAt: string): string {
  const created = Date.parse(createdAt);
  const base = Number.isFinite(created) ? created : Date.now();
  return new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function callbackAllowed(config: FeishuConnectorConfig, input: FeishuImInteraction): boolean {
  return targetAllowed(config.allowedChatIds, input.chatID) &&
    (targetAllowed(config.allowedUserIds, input.userID) || targetAllowed(config.allowedUserIds, input.userOpenID));
}

export function targetAllowed(allowlist: string[], value: string): boolean {
  return allowlist.length === 0 || (value !== "" && allowlist.includes(value));
}

export function refID(value: string, table: string): string {
  const prefix = `${table}:`;
  if (!value.startsWith(prefix) || cleanString(value.slice(prefix.length)) === "") throw new Error("invalid im interaction action ref");
  return cleanString(value.slice(prefix.length));
}

export function positiveInteger(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}
