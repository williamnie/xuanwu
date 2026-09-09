import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { PiHistoryLimitError, piJsonlLines } from "../providers/pi/sessionFileReader.ts";
import type { PiConversation } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";

const LEGACY_APP_SUPPORT_SEGMENT = "/codex-issue-runner-bun-live/";
const XUANWU_APP_SUPPORT_SEGMENT = "/xuanwu-bun-live/";
export const PI_CONVERSATION_TEXT_BYTES = 32 * 1024 * 1024;
export const PI_CONVERSATION_MESSAGE_LIMIT = 10_000;

export type PiConversationTranscriptItem = {
  created_at: string;
  id: string;
  meta: { conversation_id: string; pi_session_id: string };
  role: string;
  text: string;
};

export async function piConversationDetail(conversation: PiConversation): Promise<PiConversation & {
  message_count: number;
  transcript: PiConversationTranscriptItem[];
}> {
  const transcript = await readPiConversationTranscript(conversation);
  return { ...conversation, message_count: transcript.length, transcript };
}

async function readPiConversationTranscript(conversation: PiConversation): Promise<PiConversationTranscriptItem[]> {
  const file = resolvePiConversationSessionFile(conversation.session_file);
  if (file === "") return [];
  try {
    const handle = await open(file, "r");
    try {
      const transcript: PiConversationTranscriptItem[] = [];
      let index = 0;
      let textBytes = 0;
      for await (const line of piJsonlLines(handle, (await handle.stat()).size)) {
        const item = transcriptItemFromLine(line.text, conversation, index++);
        if (item) {
          textBytes += Buffer.byteLength(item.text, "utf8");
          if (textBytes > PI_CONVERSATION_TEXT_BYTES || transcript.length >= PI_CONVERSATION_MESSAGE_LIMIT) {
            throw new PiHistoryLimitError("Pi conversation transcript exceeds 32 MiB text or 10000 messages; archive or split this conversation");
          }
          transcript.push(item);
        }
      }
      return transcript;
    } finally {
      await handle.close();
    }
  } catch (error) {
    // 预算拒绝必须告知调用方，不能把完整历史伪装成空会话。
    if (error instanceof PiHistoryLimitError) throw error;
    return [];
  }
}

export function resolvePiConversationSessionFile(value: string): string {
  const file = value.trim();
  if (file === "" || existsSync(file)) return file;
  const migrated = file.replace(LEGACY_APP_SUPPORT_SEGMENT, XUANWU_APP_SUPPORT_SEGMENT);
  return migrated !== file && existsSync(migrated) ? migrated : file;
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
