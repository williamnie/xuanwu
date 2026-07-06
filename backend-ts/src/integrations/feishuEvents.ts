import type { ExternalEventInput } from "../db/repositories/externalEvents.ts";
import type {
  FeishuAttachment,
  FeishuConnectorConfig,
  FeishuMention,
  FeishuNormalizedMessageEvent,
  FeishuSender
} from "./feishuTypes.ts";
import { cleanString, firstDefined, firstString, numberValue, recordValue, requiredString } from "./feishuShared.ts";

type NormalizeOptions = { rawEventRef?: string };

const MILLISECOND_EPOCH_THRESHOLD = 10_000_000_000;
const UNIX_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export function normalizeFeishuMessageEvent(raw: unknown, options: NormalizeOptions = {}): FeishuNormalizedMessageEvent {
  const event = eventPayload(raw);
  const message = recordValue(event.message);
  const content = messageContent(message.content);
  const messageId = requiredString(message.message_id, "message.message_id");
  const sourceID = `feishu:message:${messageId}`;
  return {
    attachments: normalizeAttachments(message, content),
    chat_id: requiredString(message.chat_id, "message.chat_id"),
    chat_type: cleanString(message.chat_type),
    dedupe_key: sourceID,
    mentions: normalizeMentions(message.mentions),
    message_id: messageId,
    raw_event_ref: cleanString(options.rawEventRef) || cleanString(event.event_id),
    root_id: cleanString(message.root_id),
    sender: normalizeSender(event.sender),
    source_id: sourceID,
    text: messageText(content, message.content),
    thread_id: cleanString(message.parent_id) || cleanString(message.thread_id),
    timestamp: parseFeishuTimestamp(firstDefined(message.create_time, event.create_time, event.event_time))
  };
}

export function projectIDForFeishuMessage(config: FeishuConnectorConfig, event: FeishuNormalizedMessageEvent): string {
  void config;
  void event;
  return "";
}

export function feishuExternalEventInput(
  event: FeishuNormalizedMessageEvent,
  options: { projectId?: string } = {}
): ExternalEventInput {
  const projectId = cleanString(options.projectId);
  return {
    actor: feishuActor(event.sender),
    attachments: event.attachments.map(feishuAttachmentRef),
    content: event.text || attachmentSummary(event.attachments),
    dedupe_key: event.dedupe_key,
    event_type: event.mentions.length > 0 ? "message.mention" : "message",
    external_id: event.message_id,
    normalized_message: normalizedMessage(event),
    occurred_at: event.timestamp,
    project_hint: projectId,
    project_id: projectId,
    provider: "feishu",
    raw_payload_ref: event.raw_event_ref,
    received_at: event.timestamp,
    source: "feishu",
    status: projectId === "" ? "unassigned" : "mapped",
    summary: feishuSummary(event, projectId),
    trust_level: "untrusted"
  };
}

function normalizedMessage(event: FeishuNormalizedMessageEvent): Record<string, unknown> {
  return {
    attachments: event.attachments,
    chat_id: event.chat_id,
    chat_type: event.chat_type,
    mentions: event.mentions,
    message_id: event.message_id,
    root_id: event.root_id,
    sender: event.sender,
    text: event.text,
    thread_id: event.thread_id,
    timestamp: event.timestamp
  };
}

function feishuSummary(event: FeishuNormalizedMessageEvent, projectId: string): Record<string, unknown> {
  return {
    attachment_count: event.attachments.length,
    chat_id: event.chat_id,
    message_id: event.message_id,
    project_id: projectId,
    sender_type: event.sender.type,
    text_length: event.text.length
  };
}

function eventPayload(raw: unknown): Record<string, unknown> {
  const root = recordValue(raw);
  const event = recordValue(root.event);
  return Object.keys(event).length > 0 ? event : root;
}

function normalizeSender(value: unknown): FeishuSender {
  const sender = recordValue(value);
  const ids = recordValue(sender.sender_id);
  const openID = cleanString(ids.open_id);
  return {
    id: firstString(ids.user_id, openID, ids.union_id, sender.sender_id),
    open_id: openID,
    tenant_key: cleanString(sender.tenant_key),
    type: cleanString(sender.sender_type) || "unknown"
  };
}

function normalizeMentions(value: unknown): FeishuMention[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const mention = recordValue(item);
    const ids = recordValue(mention.id);
    return { id: firstString(mention.id, ids.user_id, ids.open_id), name: cleanString(mention.name), tenant_key: cleanString(mention.tenant_key) };
  }).filter((item) => item.id !== "" || item.name !== "");
}

function normalizeAttachments(message: Record<string, unknown>, content: Record<string, unknown>): FeishuAttachment[] {
  const attachments = Array.isArray(message.attachments) ? message.attachments.map(normalizeAttachment).filter((item) => item !== null) : [];
  if (attachments.length > 0) return attachments;
  const imageKey = cleanString(content.image_key);
  return imageKey === "" ? [] : [{ file_key: imageKey, mime_type: "", name: "", size: 0, type: "image" }];
}

function normalizeAttachment(value: unknown): FeishuAttachment | null {
  const item = recordValue(value);
  const fileKey = firstString(item.file_key, item.image_key, item.media_key);
  const name = firstString(item.file_name, item.name);
  if (fileKey === "" && name === "") return null;
  return { file_key: fileKey, mime_type: cleanString(item.mime_type), name, size: numberValue(item.file_size), type: cleanString(item.type) || attachmentType(item) };
}

function attachmentType(item: Record<string, unknown>): string {
  return cleanString(item.image_key) !== "" ? "image" : "file";
}

function feishuAttachmentRef(attachment: FeishuAttachment): Record<string, unknown> {
  return {
    kind: attachmentKind(attachment.type),
    mime_type: attachment.mime_type,
    name: attachment.name,
    remote_ref: attachment.file_key
  };
}

function attachmentKind(value: string): string {
  const kind = cleanString(value);
  if (["audio", "file", "image", "video"].includes(kind)) return kind;
  return "file";
}

function messageContent(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return recordValue(value);
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function messageText(content: Record<string, unknown>, rawContent: unknown): string {
  const text = cleanString(content.text);
  if (text !== "") return text;
  return typeof rawContent === "string" && rawContent.trim().startsWith("{") ? "" : cleanString(rawContent);
}

function parseFeishuTimestamp(value: unknown): string {
  const text = cleanString(value);
  if (text === "") return UNIX_EPOCH_ISO;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return unixTimestampToIso(numeric);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? UNIX_EPOCH_ISO : date.toISOString();
}

function unixTimestampToIso(value: number): string {
  return new Date(value > MILLISECOND_EPOCH_THRESHOLD ? value : value * 1000).toISOString();
}

function feishuActor(sender: FeishuSender): string {
  const id = sender.id || sender.open_id || "unknown";
  return `feishu:${sender.type || "unknown"}:${id}`;
}

function attachmentSummary(attachments: FeishuAttachment[]): string {
  if (attachments.length === 0) return "[empty feishu message]";
  return `[${attachments.length} feishu attachment metadata item(s)]`;
}
