import type { RunnerDatabase } from "../db/database.ts";
import { listExternalLinksByIssue } from "../db/repositories/externalLinks.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuTarget = { chatID: string; eventID: number; messageID: string; threadID: string };

const FEISHU_SOURCE = "feishu";

export function feishuTargetForIssue(db: RunnerDatabase, issueID: number): FeishuTarget | null {
  const links = listExternalLinksByIssue(db, issueID);
  const link = links.find((item) => item.source === FEISHU_SOURCE && item.external_type === "feishu_message") ??
    links.find((item) => item.source === FEISHU_SOURCE && item.relationship === "notification");
  if (!link) return null;
  return feishuTargetFromLink(db, link, link.conversation_id);
}

export function feishuTargetForConversation(db: RunnerDatabase, conversationID: string): FeishuTarget | null {
  const conversation = safeText(conversationID);
  if (conversation === "") return null;
  const link = latestFeishuConversationLink(db, conversation);
  if (link) return feishuTargetFromLink(db, link, conversation);
  const chatID = chatIDFromConversation(conversation);
  return chatID === "" ? null : { chatID, eventID: 0, messageID: "", threadID: "" };
}

function latestFeishuConversationLink(db: RunnerDatabase, conversationID: string) {
  return db.sqlite.query<{
    conversation_id: string; external_event_id: number; external_id: string;
  }, [string]>(
    `select conversation_id, external_event_id, external_id from external_links
     where source='feishu' and conversation_id=? and external_event_id > 0
     order by created_at desc, id desc limit 1`
  ).get(conversationID);
}

function feishuTargetFromLink(
  db: RunnerDatabase,
  link: { conversation_id: string; external_event_id: number; external_id: string },
  conversationID: string
): FeishuTarget | null {
  const message = db.sqlite.query<{ normalized_message_json: string }, [number]>(
    "select normalized_message_json from external_events where id=?"
  ).get(link.external_event_id);
  const normalized = parseObject(message?.normalized_message_json);
  const chatID = safeText(normalized.chat_id) || chatIDFromConversation(conversationID);
  const messageID = safeText(normalized.message_id) || safeText(link.external_id);
  const threadID = safeText(normalized.thread_id) || safeText(normalized.root_id);
  return chatID === "" && messageID === "" ? null : { chatID, eventID: link.external_event_id, messageID, threadID };
}

function chatIDFromConversation(conversationID: string): string {
  if (conversationID.startsWith("oc_")) return conversationID;
  const match = conversationID.match(/^feishu-chat-(.+)-\d{8}(?:-n\d+)?$/);
  return match ? safeText(match[1]) : "";
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
