import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiAction } from "../db/repositories/pi.ts";
import { getPiApprovalRequest } from "../db/repositories/pi/approvalRequests.ts";
import { getFeishuPendingProjectSelection } from "../db/repositories/feishuProjectSelection.ts";
import {
  createImInteractionBinding,
  getImInteractionBinding,
  type ImInteractionBinding,
  type ImInteractionBindingAction
} from "../db/repositories/imInteractionBindings.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { resolvePiApprovalRequestFromFeishu } from "./feishuApprovalRequests.ts";
import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { resolvePiActionFromFeishu } from "./feishuPiActionResolve.ts";
import type { FeishuApprovalAction } from "./feishuApprovalCards.ts";
import type { FeishuPiActionCardAction } from "./feishuPiActionCards.ts";
import type { FeishuProjectSelectionAction } from "./feishuProjectSelection.ts";
import {
  createImInteractionService,
  type ImInteractionCallback,
  type ImInteractionHandleResult
} from "./imInteractionService.ts";

export type FeishuImInteraction = {
  callback: ImInteractionCallback;
  chatID: string;
  messageID: string;
  userID: string;
  userOpenID: string;
};

export type FeishuImInteractionContext = {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  bus?: EventBus;
  config: FeishuConnectorConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

/** Normalize only the post-cutover opaque callback shape. */
export function normalizeFeishuImInteraction(raw: unknown): FeishuImInteraction | null {
  const root = recordValue(raw);
  const nestedEvent = recordValue(root.event);
  const event = Object.keys(nestedEvent).length > 0 ? nestedEvent : root;
  if (cleanString(recordValue(root.header).event_type || root.event_type) !== "card.action.trigger") return null;
  const action = recordValue(event.action);
  const value = recordValue(action.value);
  if (cleanString(value.action) !== "xuanwu_im_interaction") return null;
  const interactionID = cleanString(value.interaction_id);
  const actionID = cleanString(value.action_id);
  const revision = positiveInteger(value.revision);
  const context = recordValue(event.context);
  const operator = recordValue(event.operator);
  const operatorID = Object.keys(recordValue(operator.operator_id)).length > 0
    ? recordValue(operator.operator_id)
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
      eventId: cleanString(recordValue(root.header).event_id || root.event_id),
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

type LegacyInteractionInput = {
  actionID: string;
  actionKind: string;
  actionRef: string;
  actions: ImInteractionBindingAction[];
  actor: { id?: string; openId?: string };
  bindingActor: { id?: string; openId?: string };
  bindingScopeKey: string;
  businessRef: string;
  chatID: string;
  eventID: string;
  expiresAt: string;
  messageID: string;
};

async function resolveLegacyFeishuInteraction(
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

function adoptLegacyBinding(
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

function legacyInteractionID(kind: string, businessRef: string): string {
  return createHash("sha256").update(`feishu:legacy:${kind}:${businessRef}`).digest("base64url").slice(0, 32);
}

function hasLegacyBinding(database: RunnerDatabase, kind: string, businessRef: string): boolean {
  return getImInteractionBinding(database, legacyInteractionID(kind, businessRef)) !== null;
}

function legacyProjectActionID(projectID: string): string {
  return `project:${createHash("sha256").update(projectID).digest("base64url").slice(0, 16)}`;
}

function approvalActionID(action: FeishuApprovalAction): string {
  if (action.decision === "approve" && cleanString(action.scope || "turn") === "turn") return "approve";
  if (action.decision === "approve_session" && cleanString(action.scope || "session") === "session") return "approve_session";
  if (action.decision === "deny" && cleanString(action.scope || "turn") === "turn") return "deny";
  if (action.decision === "defer" && cleanString(action.scope || "turn") === "turn") return "defer";
  return "";
}

function legacyActor(input: { userID?: string; userOpenID?: string }): { id?: string; openId?: string } {
  return { ...(cleanString(input.userID) ? { id: cleanString(input.userID) } : {}), ...(cleanString(input.userOpenID) ? { openId: cleanString(input.userOpenID) } : {}) };
}

function compatibilityExpiry(createdAt: string): string {
  const created = Date.parse(createdAt);
  const base = Number.isFinite(created) ? created : Date.now();
  return new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function callbackAllowed(config: FeishuConnectorConfig, input: FeishuImInteraction): boolean {
  return targetAllowed(config.allowedChatIds, input.chatID) &&
    (targetAllowed(config.allowedUserIds, input.userID) || targetAllowed(config.allowedUserIds, input.userOpenID));
}

function targetAllowed(allowlist: string[], value: string): boolean {
  return allowlist.length === 0 || (value !== "" && allowlist.includes(value));
}

function refID(value: string, table: string): string {
  const prefix = `${table}:`;
  if (!value.startsWith(prefix) || cleanString(value.slice(prefix.length)) === "") throw new Error("invalid im interaction action ref");
  return cleanString(value.slice(prefix.length));
}

function positiveInteger(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
