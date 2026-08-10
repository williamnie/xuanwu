import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { resolveImNotificationTarget } from "./imNotificationTargets.ts";

export type FeishuTarget = { chatID: string; eventID: number; messageID: string; threadID: string };

const FEISHU_SOURCE = "feishu";

export function feishuTargetForIssue(db: RunnerDatabase, issueID: number): FeishuTarget | null {
  return legacyView(resolveImNotificationTarget(db, { connectorID: FEISHU_SOURCE, issueID }));
}

export function feishuTargetForConversation(db: RunnerDatabase, conversationID: string): FeishuTarget | null {
  const conversation = safeText(conversationID);
  if (conversation === "") return null;
  const generic = legacyView(resolveImNotificationTarget(db, {
    connectorID: FEISHU_SOURCE,
    conversationID: conversation
  }));
  if (generic) return generic;
  const chatID = chatIDFromConversation(conversation);
  return chatID === "" ? null : { chatID, eventID: 0, messageID: "", threadID: "" };
}

export function feishuTargetForProject(db: RunnerDatabase, projectID: string): FeishuTarget | null {
  return legacyView(resolveImNotificationTarget(db, { connectorID: FEISHU_SOURCE, projectID }));
}

export function feishuFallbackTargetForProject(
  config: FeishuConnectorConfig | undefined,
  projectID: string
): FeishuTarget | null {
  if (!config) return null;
  const mapping = config.projectMappings.find((item) => item.projectId === projectID);
  const chatID = safeText(mapping?.chatId) || safeText(mapping?.userId) ||
    safeText(config.defaultChatId) || safeText(config.defaultUserId);
  return chatID === "" ? null : { chatID, eventID: 0, messageID: "", threadID: "" };
}

function legacyView(target: ReturnType<typeof resolveImNotificationTarget>): FeishuTarget | null {
  if (!target) return null;
  return {
    chatID: target.conversation_id,
    eventID: target.external_event_id,
    messageID: target.reply_to_message_id ?? "",
    threadID: target.thread_id ?? ""
  };
}

function chatIDFromConversation(conversationID: string): string {
  if (conversationID.startsWith("oc_")) return conversationID;
  const match = conversationID.match(/^feishu-chat-(.+)-\d{8}(?:-n\d+)?$/);
  return match ? safeText(match[1]) : "";
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
