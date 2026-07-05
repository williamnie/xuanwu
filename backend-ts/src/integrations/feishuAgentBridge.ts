import type { RunnerDatabase } from "../db/database.ts";
import { resolveFeishuProjectContextFromDatabase, type FeishuProjectContextResult } from "./feishuProjectContext.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import { createFeishuMessageClient, type FeishuMessageClient, type FeishuTextMessageResult } from "./feishuClient.ts";
import {
  parseFeishuNewConversationCommand,
  routeFeishuConversation,
  type FeishuConversationClock,
  type FeishuConversationRoute
} from "./feishuConversationRouting.ts";
import {
  handleFeishuProjectSelectionAction,
  maybeSendFeishuProjectSelection,
  type FeishuProjectSelectionAction
} from "./feishuProjectSelectionBridge.ts";
import { buildFeishuIssueCommandPrompt, parseFeishuIssueCommand } from "./feishuIssueCommand.ts";
import { applyFeishuMemoryCommand } from "./feishuMemoryCommands.ts";
import { appendFeishuMemoryCandidateNotice, snapshotFeishuMemoryCandidates } from "./feishuMemoryCandidateNotice.ts";
import { applyFeishuProjectSwitchCommand } from "./feishuProjectSwitch.ts";
import { applyFeishuCompletionWatchCommand } from "./feishuCompletionWatchCommand.ts";
import { applyFeishuNotificationPreferenceCommand } from "./feishuNotificationPreferenceBridge.ts";
import { buildFeishuReviewCommandPrompt, normalizeFeishuReviewReply, parseFeishuReviewCommand } from "./feishuReviewCommand.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";

export type FeishuConversationRunner = (input: FeishuRunnerInput) => Promise<FeishuRunnerResult>;
export type FeishuRunnerInput = {
  conversationId: string;
  event: FeishuNormalizedMessageEvent;
  intent?: string;
  prompt: string;
  projectId: string;
};
export type FeishuRunnerResult = { conversationId?: string; projectId?: string; text: string };
type FeishuAgentBridgeOptions = {
  clock?: FeishuConversationClock;
  config: () => FeishuConnectorConfig;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};
type DirectReply = { reason: string; text: string };
export type FeishuBridgeHandleInput = { event: FeishuNormalizedMessageEvent; ingest: FeishuIngestResult };
export type FeishuBridgeHandleResult = { reason: string; replied: boolean };

const REPLY_LINK_TYPE = "feishu_agent_reply", REPLY_RELATIONSHIP = "agent_reply";
const ACK_REACTION_EMOJI_TYPE = "OK";
const CHAT_ACK_TEXT = "我在。你可以像平时聊天一样描述想让我做的事，例如“在 codex-issue-runner 里帮我修复登录报错”。";
const NEW_CONVERSATION_ACK_TEXT = "已开启新的 PI 上下文。你可以继续发下一条消息。";
const PROJECT_CLARIFICATION_TEXT = "我收到任务了，但还不知道要交给哪个 Runner 项目。请先发送 `/p <项目名>` 切换项目，或在消息里带上项目名后再发。";
const ISSUE_PROJECT_CLARIFICATION_TEXT = "这是哪个项目？你可以直接回复项目名，或把项目名带在任务里。";

export function createFeishuAgentBridge(options: FeishuAgentBridgeOptions) {
  const inFlightReplies = new Set<string>();
  return {
    handle: (input: FeishuBridgeHandleInput) => handleFeishuAgentMessage(options, input, inFlightReplies),
    handleProjectSelectionAction: (action: FeishuProjectSelectionAction) =>
      handleFeishuProjectSelectionAction(options, action)
  };
}

async function handleFeishuAgentMessage(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  inFlightReplies: Set<string>
): Promise<FeishuBridgeHandleResult> {
  const policy = replyPolicy(input);
  if (policy) return { reason: policy, replied: false };
  const replyKey = replyDedupeKey(input.event);
  if (inFlightReplies.has(replyKey)) return { reason: "duplicate_reply_in_flight", replied: false };
  inFlightReplies.add(replyKey);
  try {
    return await handleFeishuAgentMessageOnce(options, input);
  } finally {
    inFlightReplies.delete(replyKey);
  }
}

async function handleFeishuAgentMessageOnce(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): Promise<FeishuBridgeHandleResult> {
  if (alreadyReplied(options.database, input.event)) return { reason: "duplicate_reply", replied: false };
  await sendAckReaction(options, input);
  const route = conversationRoute(options, input);
  const projectContext = projectContextForRoute(options, input, route);
  const handled = await handledReply(options, input, route, projectContext);
  if (handled) return handled;
  const runner = await runnerReply(options, input, route, projectContext);
  const text = cleanString(runner.text);
  if (text === "") return { reason: "empty_agent_reply", replied: false };
  return sendReply(options, input, text, runner, "agent_reply_sent");
}

async function handledReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): Promise<FeishuBridgeHandleResult | null> {
  const memoryCommand = applyFeishuMemoryCommand(options.database, {
    conversationId: route.conversationId,
    projectId: resolvedProjectId(projectContext, input),
    text: input.event.text
  });
  if (memoryCommand.handled) return sendReply(options, input, memoryCommand.text, {
    conversationId: route.conversationId, projectId: resolvedProjectId(projectContext, input), text: memoryCommand.text
  }, memoryCommand.reason);
  return handledNonMemoryReply(options, input, route, projectContext);
}

async function handledNonMemoryReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): Promise<FeishuBridgeHandleResult | null> {
  const notificationPreference = applyFeishuNotificationPreferenceCommand(options.database, {
    conversationId: route.conversationId,
    event: input.event,
    ingest: input.ingest,
    now: options.clock?.now(),
    projectId: resolvedProjectId(projectContext, input),
    text: input.event.text
  });
  if (notificationPreference.handled) return sendReply(options, input, notificationPreference.text, {
    conversationId: route.conversationId, projectId: resolvedProjectId(projectContext, input), text: notificationPreference.text
  }, notificationPreference.reason);
  const projectSwitch = applyFeishuProjectSwitchCommand(options.database, {
    route,
    timestamp: options.clock?.now(),
    text: input.event.text
  });
  if (projectSwitch.status !== "none") return sendReply(options, input, projectSwitch.text, {
    conversationId: route.conversationId, projectId: projectSwitch.projectId, text: projectSwitch.text
  }, projectSwitch.reason);
  const completionWatch = applyFeishuCompletionWatchCommand(options.database, {
    event: input.event,
    projectContext,
    route,
    sourceEventId: String(input.ingest.event_id || input.event.dedupe_key),
    text: route.prompt || input.event.text
  });
  if (completionWatch.handled) return sendReply(options, input, completionWatch.text, {
    conversationId: route.conversationId, projectId: completionWatch.projectId, text: completionWatch.text
  }, completionWatch.reason);
  const issueClarification = issueCommandClarification(input, route, projectContext);
  if (issueClarification) return sendReply(options, input, issueClarification.text, {
    conversationId: route.conversationId, projectId: "", text: issueClarification.text
  }, issueClarification.reason);
  return handledSelectionOrDirectReply(options, input, route, projectContext);
}

async function handledSelectionOrDirectReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): Promise<FeishuBridgeHandleResult | null> {
  const selection = await maybeSendFeishuProjectSelection(options, input, route, projectContext, attentionDecision(input.ingest));
  if (selection) {
    recordReplyLink(options.database, input, { conversationId: route.conversationId, projectId: "", text: "project selection requested" }, { messageId: selection.messageId });
    return { reason: selection.reason, replied: selection.replied };
  }
  const direct = directReply(input, options, projectContext);
  if (!direct) return null;
  return sendReply(options, input, direct.text, {
    conversationId: route.conversationId, projectId: resolvedProjectId(projectContext, input), text: direct.text
  }, direct.reason);
}

async function sendReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  text: string,
  runner: FeishuRunnerResult,
  reason: string
): Promise<FeishuBridgeHandleResult> {
  const sent = await messageSender(options).sendTextMessage({
    receiveId: input.event.chat_id,
    receiveIdType: "chat_id",
    text
  });
  recordReplyLink(options.database, input, runner, sent);
  return { reason, replied: true };
}

async function runnerReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): Promise<FeishuRunnerResult> {
  try {
    if (!options.runConversation) return { text: "" };
    const projectId = resolvedProjectId(projectContext, input);
    if (route.isNewCommand && route.prompt === "") {
      return { conversationId: route.conversationId, projectId, text: NEW_CONVERSATION_ACK_TEXT };
    }
    const command = parseFeishuIssueCommand(route.prompt || input.event.text);
    const review = parseFeishuReviewCommand(route.prompt || input.event.text);
    const normalChat = !command && !review;
    const memoryBefore = normalChat ? snapshotFeishuMemoryCandidates(options.database, {
      conversationId: route.conversationId,
      projectId
    }) : [];
    const prompt = review
      ? buildFeishuReviewCommandPrompt(options.database, { conversationId: route.conversationId, projectId })
      : command ? buildFeishuIssueCommandPrompt(command) : route.prompt || input.event.text || "[Feishu attachment message]";
    const result = await options.runConversation({
      conversationId: route.conversationId,
      event: input.event,
      intent: review ? "review" : undefined,
      projectId,
      prompt
    });
    const text = review ? normalizeFeishuReviewReply(result.text) : normalChat ? appendFeishuMemoryCandidateNotice(
      options.database, { conversationId: route.conversationId, projectId }, result.text, memoryBefore
    ) : result.text;
    return { ...result, text };
  } catch (error) {
    return {
      conversationId: fallbackConversationID(input.event),
      text: `我尝试交给 Runner 时出错了：${safeError(error)}。你可以稍后重试，或补充项目名和目标再发我一次。`
    };
  }
}

function messageSender(options: FeishuAgentBridgeOptions): FeishuMessageClient {
  return options.sender ?? createFeishuMessageClient({ config: options.config() });
}

async function sendAckReaction(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): Promise<void> {
  const sender = messageSender(options);
  if (!sender.addMessageReaction) return;
  try {
    await sender.addMessageReaction({
      emojiType: ACK_REACTION_EMOJI_TYPE,
      messageId: input.event.message_id
    });
  } catch (error) {
    console.warn(JSON.stringify({
      action: "feishu_ack_reaction",
      error: safeError(error),
      ok: false
    }));
  }
}

function replyPolicy(input: FeishuBridgeHandleInput): string {
  const decision = attentionDecision(input.ingest);
  if (input.event.chat_id === "") return "missing_chat_id";
  if (decision === "ignore") return "ignored_by_attention";
  if (decision === "blocked_by_policy") return "blocked_by_policy";
  return "";
}

function directReply(
  input: FeishuBridgeHandleInput,
  options: FeishuAgentBridgeOptions,
  projectContext: FeishuProjectContextResult
): DirectReply | null {
  const decision = attentionDecision(input.ingest);
  if (decision === "inbox_only" && !options.runConversation) {
    return { reason: "chat_ack_sent", text: CHAT_ACK_TEXT };
  }
  if (decision === "ask_clarification" && projectContext.status !== "resolved" && !isNewPromptWithContent(input.event.text)) {
    return { reason: "project_clarification_sent", text: PROJECT_CLARIFICATION_TEXT };
  }
  return null;
}

function issueCommandClarification(
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): DirectReply | null {
  if (!parseFeishuIssueCommand(route.prompt || input.event.text)) return null;
  if (projectContext.status === "resolved") return null;
  return { reason: "project_clarification_sent", text: ISSUE_PROJECT_CLARIFICATION_TEXT };
}

function isNewPromptWithContent(prompt: string): boolean {
  const command = parseFeishuNewConversationCommand(prompt);
  return command.isNewCommand && command.prompt !== "";
}

function conversationRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): FeishuConversationRoute {
  return routeFeishuConversation(options.database, {
    clock: options.clock,
    event: input.event,
    prompt: input.event.text || "[Feishu attachment message]"
  });
}

function projectContextForRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute
): FeishuProjectContextResult {
  return resolveFeishuProjectContextFromDatabase(options.database, {
    mappings: options.config().projectMappings,
    message: {
      chatId: input.event.chat_id,
      senderId: input.event.sender.id,
      senderOpenId: input.event.sender.open_id
    },
    scopeKey: route.scopeKey,
    text: route.prompt || input.event.text
  });
}

function resolvedProjectId(
  context: FeishuProjectContextResult,
  input: FeishuBridgeHandleInput
): string {
  return context.status === "resolved" ? context.projectId : attentionProjectId(input.ingest);
}

function attentionDecision(input: FeishuIngestResult): string {
  const summary = input.normalized_summary;
  const decision = summary.attention_decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return "";
  return cleanString((decision as Record<string, unknown>).decision);
}

function attentionProjectId(input: FeishuIngestResult): string {
  const summary = input.normalized_summary;
  const decision = summary.attention_decision;
  if (decision && typeof decision === "object" && !Array.isArray(decision)) {
    return cleanString((decision as Record<string, unknown>).project_id);
  }
  return cleanString(summary.project_id);
}

function alreadyReplied(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): boolean {
  return listExternalLinksByExternal(db, {
    externalID: event.message_id,
    externalType: REPLY_LINK_TYPE,
    limit: 1,
    source: "feishu"
  }).some((item) => item.relationship === REPLY_RELATIONSHIP);
}

function replyDedupeKey(event: FeishuNormalizedMessageEvent): string {
  return cleanString(event.dedupe_key) || `feishu:message:${cleanString(event.message_id)}`;
}

function recordReplyLink(
  db: RunnerDatabase,
  input: FeishuBridgeHandleInput,
  runner: FeishuRunnerResult,
  sent: FeishuTextMessageResult
): void {
  createExternalLink(db, {
    conversation_id: cleanString(runner.conversationId) || fallbackConversationID(input.event),
    external_event_id: input.ingest.event_id,
    external_id: input.event.message_id,
    external_type: REPLY_LINK_TYPE,
    loop_run_id: `feishu_reply:${sent.messageId}`,
    project_id: cleanString(runner.projectId) || attentionProjectId(input.ingest),
    relationship: REPLY_RELATIONSHIP,
    source: "feishu"
  });
}

function fallbackConversationID(event: FeishuNormalizedMessageEvent): string {
  return `feishu:${event.message_id}`;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
