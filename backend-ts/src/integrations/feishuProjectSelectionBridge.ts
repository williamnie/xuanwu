import type { RunnerDatabase } from "../db/database.ts";
import {
  consumeFeishuPendingProjectSelection,
  createFeishuPendingProjectSelection,
  type FeishuPendingProjectSelection
} from "../db/repositories/feishuProjectSelection.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import {
  createFeishuMessageClient,
  type FeishuMessageClient
} from "./feishuClient.ts";
import { createFeishuChannelConnector, createFeishuOutboundEnvelope } from "./feishuChannelConnector.ts";
import type { FeishuConversationClock, FeishuConversationRoute } from "./feishuConversationRouting.ts";
import type { FeishuProjectContextResult } from "./feishuProjectContext.ts";
import type {
  FeishuBridgeHandleInput,
  FeishuBridgeHandleResult,
  FeishuConversationRunner
} from "./feishuAgentBridge.ts";
import {
  buildFeishuProjectSelectionCard,
  type FeishuProjectSelectionAction
} from "./feishuProjectSelection.ts";

export type FeishuProjectSelectionBridgeOptions = {
  clock?: FeishuConversationClock;
  config: () => FeishuConnectorConfig;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};
export type FeishuProjectSelectionSendResult = FeishuBridgeHandleResult & { messageId: string };

const PROJECT_SELECTION_TTL_MS = 30 * 60 * 1000;
const MAX_CANDIDATES = 8;

export async function maybeSendFeishuProjectSelection(
  options: FeishuProjectSelectionBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  context: FeishuProjectContextResult,
  decision: string
): Promise<FeishuProjectSelectionSendResult | null> {
  if (!shouldAskProjectSelection(options, context, decision, input.event.text)) return null;
  const candidates = selectionCandidates(options.database, context);
  if (candidates.length === 0) return null;
  const now = options.clock?.now() ?? new Date();
  const selection = savePendingSelection(options, input, route, candidates, now);
  const messageId = await sendSelectionPrompt(options, input.event.chat_id, selection, candidates);
  return { messageId, reason: "project_selection_sent", replied: true };
}

export async function handleFeishuProjectSelectionAction(
  options: FeishuProjectSelectionBridgeOptions,
  action: FeishuProjectSelectionAction
): Promise<FeishuBridgeHandleResult> {
  const now = options.clock?.now() ?? new Date();
  const consumed = consumeFeishuPendingProjectSelection(options.database, {
    chatId: action.chat_id,
    now,
    projectId: action.project_id,
    selectionId: action.selection_id,
    userId: action.user_id,
    userOpenId: action.user_open_id
  });
  if (consumed.status !== "consumed" || !consumed.selection) {
    const chatID = action.chat_id || consumed.selection?.chat_id || "";
    if (chatID === "") return { reason: `project_selection_${consumed.status}`, replied: false };
    await sendActionText(
      options,
      chatID,
      selectionFailureText(consumed.status, consumed.selection?.selected_project_id),
      `${action.selection_id}:${consumed.status}`
    );
    return { reason: `project_selection_${consumed.status}`, replied: true };
  }
  await sendActionText(options, action.chat_id, `已选择 ${action.project_id}，我会用它处理刚才这句。`, action.selection_id);
  return continuePendingPrompt(options, consumed.selection, action.project_id);
}

function selectionFailureText(status: string, selectedProjectID = ""): string {
  if (status === "already_consumed") {
    return selectedProjectID === ""
      ? "这个项目选择已经处理过了，不会重复执行。"
      : `这个项目选择已经用 ${selectedProjectID} 处理过了，不会重复执行。`;
  }
  if (status === "expired") return "这个项目选择已过期，请重新发送原请求。";
  if (status === "source_mismatch") return "这个项目选择不属于当前会话或当前用户，请从原消息重新操作。";
  if (status === "invalid_project") return "这个项目不在本次候选列表中，请重新发送请求并写明项目名或 issue id。";
  return "没有找到这次项目选择，请重新发送原请求。";
}

function shouldAskProjectSelection(
  options: FeishuProjectSelectionBridgeOptions,
  context: FeishuProjectContextResult,
  decision: string,
  prompt: string
): boolean {
  if (!options.runConversation || context.status === "resolved") return false;
  if (decision === "ask_clarification" || decision === "propose_issue") return true;
  return decision === "inbox_only" && isContinuationPrompt(prompt);
}

function isContinuationPrompt(prompt: string): boolean {
  return /^(开始|开始做|开始吧|开始做吧|继续|继续做|接着|接着做|下一个|跑起来)$/i.test(cleanString(prompt)) ||
    /#\s*\d+\s*[-~～—–]\s*#?\s*\d+|所有|全部|剩下都|剩余都|这个系列|这一系列|这组都|这一组都/i.test(cleanString(prompt));
}

function selectionCandidates(
  db: RunnerDatabase,
  context: FeishuProjectContextResult
): Array<{ id: string; name: string }> {
  const projects = listProjects(db).map((project) => ({ id: project.id, name: project.name }));
  if (context.candidates.length === 0) return projects.slice(0, MAX_CANDIDATES);
  const allowed = new Set(context.candidates);
  return projects.filter((project) => allowed.has(project.id)).slice(0, MAX_CANDIDATES);
}

function savePendingSelection(
  options: FeishuProjectSelectionBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  candidates: Array<{ id: string }>,
  now: Date
): FeishuPendingProjectSelection {
  return createFeishuPendingProjectSelection(options.database, {
    candidates: candidates.map((project) => project.id),
    chatId: input.event.chat_id,
    conversationId: route.conversationId,
    expiresAt: new Date(now.getTime() + PROJECT_SELECTION_TTL_MS).toISOString(),
    originalPrompt: route.prompt || input.event.text || "[Feishu attachment message]",
    scopeKey: route.scopeKey,
    selectionId: crypto.randomUUID(),
    sourceMessageId: input.event.message_id,
    userId: input.event.sender.id,
    userOpenId: input.event.sender.open_id
  }, now);
}

async function sendSelectionPrompt(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  selection: FeishuPendingProjectSelection,
  candidates: Array<{ id: string; name: string }>
): Promise<string> {
  const sender = messageSender(options);
  const auditRef = `feishu-project-selection:${selection.selection_id}`;
  let operation: "card.send" | "message.reply" = "message.reply";
  let payload: Record<string, unknown>;
  if (sender.sendInteractiveCard) {
    const card = buildFeishuProjectSelectionCard({
      candidates,
      originalPrompt: selection.original_prompt,
      selectionId: selection.selection_id
    });
    operation = "card.send";
    payload = { card };
  } else {
    payload = { text: fallbackSelectionText(candidates) };
  }
  const receipt = await createFeishuChannelConnector({ config: options.config, sender }).deliver!(createFeishuOutboundEnvelope({
    actionGateRef: `${auditRef}:pending`,
    actionID: `${auditRef}:prompt`,
    authority: "deterministic_policy",
    correlationID: selection.conversation_id,
    eventRef: auditRef,
    idempotencyKey: `${auditRef}:prompt`,
    occurredAt: selection.created_at,
    operation,
    payload,
    receiveID: chatId,
    receiveIDType: "chat_id"
  }));
  return receipt.provider_request_ref;
}

async function continuePendingPrompt(
  options: FeishuProjectSelectionBridgeOptions,
  selection: FeishuPendingProjectSelection,
  projectId: string
): Promise<FeishuBridgeHandleResult> {
  if (!options.runConversation) return savedOnly(options, selection.chat_id, projectId);
  try {
    const runner = await options.runConversation({
      conversationId: selection.conversation_id,
      event: pendingEvent(selection),
      projectId: "",
      targetProjectId: projectId,
      targetProjectSource: "card_select",
      prompt: selection.original_prompt
    });
    if (cleanString(runner.text) !== "") await sendActionText(options, selection.chat_id, runner.text, selection.selection_id);
    return { reason: "project_selection_continued", replied: true };
  } catch (error) {
    return continueFailure(options, selection.chat_id, projectId, error);
  }
}

async function savedOnly(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  projectId: string
): Promise<FeishuBridgeHandleResult> {
  await sendActionText(options, chatId, `已选择 ${projectId}。请把项目名或 issue id 写在具体请求里。`, `saved:${projectId}`);
  return { reason: "project_selection_saved", replied: true };
}

async function continueFailure(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  projectId: string,
  error: unknown
): Promise<FeishuBridgeHandleResult> {
  await sendActionText(options, chatId, `已选择 ${projectId}，但继续处理刚才请求时出错：${safeError(error)}。你可以稍后重试。`, `failed:${projectId}`);
  return { reason: "project_selection_continue_failed", replied: true };
}

async function sendActionText(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  text: string,
  correlation: string
): Promise<void> {
  const ref = `feishu-project-selection:${correlation}`;
  await createFeishuChannelConnector({ config: options.config, sender: messageSender(options) }).deliver!(createFeishuOutboundEnvelope({
    actionGateRef: `${ref}:consumed`,
    actionID: `${ref}:reply`,
    authority: "deterministic_policy",
    correlationID: ref,
    eventRef: ref,
    idempotencyKey: `${ref}:reply:${stableTextKey(text)}`,
    operation: "message.reply",
    payload: { text },
    receiveID: chatId,
    receiveIDType: "chat_id"
  }));
}

function pendingEvent(selection: FeishuPendingProjectSelection): FeishuNormalizedMessageEvent {
  const sourceID = `feishu:project-selection:${selection.selection_id}`;
  return {
    attachments: [],
    chat_id: selection.chat_id,
    chat_type: "",
    dedupe_key: sourceID,
    mentions: [],
    message_id: selection.source_message_id || selection.selection_id,
    raw_event_ref: "",
    root_id: "",
    sender: { id: selection.user_id, open_id: selection.user_open_id, tenant_key: "", type: "user" },
    source_id: sourceID,
    text: selection.original_prompt,
    thread_id: "",
    timestamp: selection.created_at
  };
}

function fallbackSelectionText(candidates: Array<{ id: string }>): string {
  const ids = candidates.map((project) => project.id).join("、");
  return `请选择本次操作的 Runner 项目：${ids}。也可以重新发送并在消息里带上项目名或 issue id。`;
}

function messageSender(options: FeishuProjectSelectionBridgeOptions): FeishuMessageClient {
  return options.sender ?? createFeishuMessageClient({ config: options.config() });
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableTextKey(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export type { FeishuProjectSelectionAction } from "./feishuProjectSelection.ts";
