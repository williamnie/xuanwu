import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import {
  createFeishuMessageClient,
  type FeishuMessageClient,
  type FeishuTextMessageResult
} from "./feishuClient.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";

export type FeishuConversationRunner = (input: FeishuRunnerInput) => Promise<FeishuRunnerResult>;
export type FeishuRunnerInput = {
  event: FeishuNormalizedMessageEvent;
  prompt: string;
  projectId: string;
};
export type FeishuRunnerResult = { conversationId?: string; projectId?: string; text: string };
export type FeishuBridgeHandleInput = { event: FeishuNormalizedMessageEvent; ingest: FeishuIngestResult };
export type FeishuBridgeHandleResult = { reason: string; replied: boolean };

type FeishuAgentBridgeOptions = {
  config: () => FeishuConnectorConfig;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};
type DirectReply = { reason: string; text: string };

const REPLY_LINK_TYPE = "feishu_agent_reply";
const REPLY_RELATIONSHIP = "agent_reply";
const CHAT_ACK_TEXT = "我在，已经收到。需要我处理具体任务时，直接说明要做什么；如果要绑定默认项目，可以在飞书设置里配置 Project Mappings。";
const PROJECT_CLARIFICATION_TEXT = "我收到任务了，但还不知道要交给哪个 Runner 项目。请在设置页添加 Project Mappings，或在消息里带上项目名后再发。";

export function createFeishuAgentBridge(options: FeishuAgentBridgeOptions) {
  return {
    handle: (input: FeishuBridgeHandleInput) => handleFeishuAgentMessage(options, input)
  };
}

async function handleFeishuAgentMessage(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): Promise<FeishuBridgeHandleResult> {
  const policy = replyPolicy(input);
  if (policy) return { reason: policy, replied: false };
  if (alreadyReplied(options.database, input.event)) return { reason: "duplicate_reply", replied: false };
  const direct = directReply(input);
  if (direct) return sendReply(options, input, direct.text, {
    conversationId: fallbackConversationID(input.event),
    text: direct.text
  }, direct.reason);
  const runner = await runnerReply(options, input);
  const text = cleanString(runner.text);
  if (text === "") return { reason: "empty_agent_reply", replied: false };
  return sendReply(options, input, text, runner, "agent_reply_sent");
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
  input: FeishuBridgeHandleInput
): Promise<FeishuRunnerResult> {
  try {
    if (!options.runConversation) return { text: "" };
    return await options.runConversation({
      event: input.event,
      projectId: attentionProjectId(input.ingest),
      prompt: input.event.text || "[Feishu attachment message]"
    });
  } catch (error) {
    return {
      conversationId: fallbackConversationID(input.event),
      text: `Runner agent failed: ${safeError(error)}`
    };
  }
}

function messageSender(options: FeishuAgentBridgeOptions): FeishuMessageClient {
  return options.sender ?? createFeishuMessageClient({ config: options.config() });
}

function replyPolicy(input: FeishuBridgeHandleInput): string {
  const decision = attentionDecision(input.ingest);
  if (input.event.chat_id === "") return "missing_chat_id";
  if (decision === "ignore") return "ignored_by_attention";
  if (decision === "blocked_by_policy") return "blocked_by_policy";
  return "";
}

function directReply(input: FeishuBridgeHandleInput): DirectReply | null {
  const decision = attentionDecision(input.ingest);
  if (decision === "inbox_only") return { reason: "chat_ack_sent", text: CHAT_ACK_TEXT };
  if (decision === "ask_clarification") {
    return { reason: "project_clarification_sent", text: PROJECT_CLARIFICATION_TEXT };
  }
  return null;
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
