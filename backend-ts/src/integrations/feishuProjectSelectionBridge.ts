import type { RunnerDatabase } from "../db/database.ts";
import {
  consumeFeishuPendingProjectSelection,
  type FeishuPendingProjectSelection
} from "../db/repositories/feishuProjectSelection.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import {
  createFeishuMessageClient,
  type FeishuMessageClient
} from "./feishuClient.ts";
import { createFeishuChannelConnector, createFeishuOutboundEnvelope } from "./feishuChannelConnector.ts";
import type { FeishuConversationClock } from "./feishuConversationRouting.ts";
import type {
  FeishuBridgeHandleResult,
  FeishuConversationRunner
} from "./feishuAgentBridge.ts";
import type { FeishuProjectSelectionAction } from "./feishuProjectSelection.ts";

export type FeishuProjectSelectionBridgeOptions = {
  clock?: FeishuConversationClock;
  config: () => FeishuConnectorConfig;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};

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
