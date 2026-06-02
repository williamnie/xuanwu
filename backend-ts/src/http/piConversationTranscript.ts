import { readFileSync } from "node:fs";
import type { PiConversation } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type PiConversationTranscriptItem = {
  created_at: string;
  id: string;
  meta: { conversation_id: string; pi_session_id: string };
  role: string;
  text: string;
};

export function piConversationDetail(conversation: PiConversation): PiConversation & {
  message_count: number;
  transcript: PiConversationTranscriptItem[];
} {
  const transcript = readPiConversationTranscript(conversation);
  return { ...conversation, message_count: transcript.length, transcript };
}

function readPiConversationTranscript(conversation: PiConversation): PiConversationTranscriptItem[] {
  const file = conversation.session_file.trim();
  if (file === "") return [];
  try {
    return parsePiSessionJsonl(readFileSync(file, "utf8"), conversation);
  } catch {
    return [];
  }
}

function parsePiSessionJsonl(text: string, conversation: PiConversation): PiConversationTranscriptItem[] {
  return text.split(/\r?\n/)
    .map((line, index) => transcriptItemFromLine(line, conversation, index))
    .filter((item): item is PiConversationTranscriptItem => Boolean(item));
}

function transcriptItemFromLine(
  line: string,
  conversation: PiConversation,
  index: number
): PiConversationTranscriptItem | null {
  const entry = parseJsonLine(line);
  if (entry.type !== "message") return null;
  const message = recordValue(entry.message);
  const role = cleanString(message.role);
  if (role !== "user" && role !== "assistant") return null;
  const error = cleanString(message.errorMessage);
  const text = messageText(message, error);
  if (text === "") return null;
  return {
    id: cleanString(entry.id) || `${conversation.id}-${index}`,
    role: role === "assistant" && error !== "" ? "error" : role,
    text,
    created_at: cleanString(entry.timestamp),
    meta: { conversation_id: conversation.id, pi_session_id: conversation.pi_session_id }
  };
}

function parseJsonLine(line: string): Record<string, unknown> {
  const text = line.trim();
  if (text === "") return {};
  try {
    return recordValue(JSON.parse(text));
  } catch {
    return {};
  }
}

function messageText(message: Record<string, unknown>, error: string): string {
  const text = collectMessageText(message.content);
  if (text !== "") return text;
  return error === "" ? "" : `Runner 执行失败：${redactSensitiveText(error)}`;
}

function collectMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(contentBlockText).filter((text) => text !== "").join("\n").trim();
}

function contentBlockText(block: unknown): string {
  return cleanString(recordValue(block).text);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
