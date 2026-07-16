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
    return { reason: `project_selection_${consumed.status}`, replied: false };
  }
  await sendActionText(options, action.chat_id, `已选择 ${action.project_id}，我会用它处理刚才这句。`);
  return continuePendingPrompt(options, consumed.selection, action.project_id);
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
  if (sender.sendInteractiveCard) {
    const card = buildFeishuProjectSelectionCard({
      candidates,
      originalPrompt: selection.original_prompt,
      selectionId: selection.selection_id
    });
    return (await sender.sendInteractiveCard({ card, receiveId: chatId, receiveIdType: "chat_id" })).messageId;
  }
  const sent = await sender.sendTextMessage({
    receiveId: chatId,
    receiveIdType: "chat_id",
    text: fallbackSelectionText(candidates)
  });
  return sent.messageId;
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
    if (cleanString(runner.text) !== "") await sendActionText(options, selection.chat_id, runner.text);
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
  await sendActionText(options, chatId, `已选择 ${projectId}。请把项目名或 issue id 写在具体请求里。`);
  return { reason: "project_selection_saved", replied: true };
}

async function continueFailure(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  projectId: string,
  error: unknown
): Promise<FeishuBridgeHandleResult> {
  await sendActionText(options, chatId, `已选择 ${projectId}，但继续处理刚才请求时出错：${safeError(error)}。你可以稍后重试。`);
  return { reason: "project_selection_continue_failed", replied: true };
}

async function sendActionText(
  options: FeishuProjectSelectionBridgeOptions,
  chatId: string,
  text: string
): Promise<void> {
  await messageSender(options).sendTextMessage({ receiveId: chatId, receiveIdType: "chat_id", text });
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

export type { FeishuProjectSelectionAction } from "./feishuProjectSelection.ts";
