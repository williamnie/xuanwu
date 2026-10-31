/**
 * Standard source-plugin event line (ADR-XW-0098 TD-2 §5.1/§5.2).
 * Plugins emit these as JSONL; the host validates them before anything reaches Inbox.
 * Everything here is untrusted third-party data.
 */
export const SOURCE_CHAT_TYPES = ["direct", "group", "email_thread", "other"] as const;
export type SourceChatType = typeof SOURCE_CHAT_TYPES[number];

export type SourceEventLine = {
  type: "event";
  id: string;
  occurred_at: string;
  chat: { key: string; type: SourceChatType; label: string };
  thread_key: string;
  sender: { key: string; name: string };
  is_self: boolean;
  text: string;
  truncated: boolean;
  reply_target: Record<string, unknown> | null;
  hints: Record<string, unknown>;
  url: string | null;
};

export type SourceEventValidation =
  | { ok: true; event: SourceEventLine }
  | { ok: false; reason: string };

export const SOURCE_EVENT_ID_MAX = 512;
export const SOURCE_EVENT_TEXT_MAX = 8000;
export const SOURCE_EVENT_REPLY_TARGET_MAX_BYTES = 4096;

type JsonObject = Record<string, unknown>;

export function validateSourceEventLine(value: unknown): SourceEventValidation {
  const line = objectValue(value);
  if (line.type !== undefined && line.type !== "event") return { ok: false, reason: "not_an_event_line" };
  const id = text(line.id);
  if (id === "" || id.length > SOURCE_EVENT_ID_MAX) return { ok: false, reason: "invalid_id" };
  const occurredAt = isoTime(line.occurred_at);
  if (occurredAt === "") return { ok: false, reason: "invalid_occurred_at" };
  const chat = objectValue(line.chat);
  const chatKey = text(chat.key);
  if (chatKey === "") return { ok: false, reason: "missing_chat_key" };
  const sender = objectValue(line.sender);
  const senderKey = text(sender.key);
  if (senderKey === "") return { ok: false, reason: "missing_sender_key" };
  if (typeof line.is_self !== "boolean") return { ok: false, reason: "missing_is_self" };
  const replyTarget = replyTargetValue(line.reply_target);
  if (replyTarget === undefined) return { ok: false, reason: "reply_target_too_large" };
  const body = typeof line.text === "string" ? line.text : "";
  const runes = [...body];
  const truncated = runes.length > SOURCE_EVENT_TEXT_MAX;
  return {
    ok: true,
    event: {
      type: "event",
      id,
      occurred_at: occurredAt,
      chat: { key: chatKey, type: chatType(chat.type), label: text(chat.label) },
      thread_key: text(line.thread_key),
      sender: { key: senderKey, name: text(sender.name) || senderKey },
      is_self: line.is_self,
      text: truncated ? runes.slice(0, SOURCE_EVENT_TEXT_MAX).join("") : body,
      truncated,
      reply_target: replyTarget,
      hints: objectValue(line.hints),
      url: text(line.url) || null
    }
  };
}

/** Accepts ISO strings and second / millisecond epoch values (as numbers or digit strings). */
export function isoTime(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : text(value);
  if (raw === "") return "";
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return "";
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function replyTargetValue(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) return null;
  const target = objectValue(value);
  if (Object.keys(target).length === 0) return null;
  if (new TextEncoder().encode(JSON.stringify(target)).length > SOURCE_EVENT_REPLY_TARGET_MAX_BYTES) return undefined;
  return target;
}

function chatType(value: unknown): SourceChatType {
  return SOURCE_CHAT_TYPES.includes(value as SourceChatType) ? value as SourceChatType : "other";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
