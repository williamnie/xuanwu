import type { RunnerDatabase } from "../db/database.ts";
import { getPiConversation } from "../db/repositories/pi.ts";
import { piConversationDetail } from "../http/piConversationTranscript.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuReviewCommand = { focus: string };
export type FeishuReviewPromptInput = {
  conversationId: string;
  projectId?: string;
};

const MAX_TRANSCRIPT_ITEMS = 18;
const MAX_TRANSCRIPT_ITEM_RUNES = 600;
const MAX_REVIEW_REPLY_RUNES = 3500;
const REVIEW_HEADINGS = ["记忆候选", "待办候选", "需要你确认/授权的事项"] as const;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function parseFeishuReviewCommand(text: string): FeishuReviewCommand | null {
  const match = cleanString(text).match(/^\/review(?:\s+([\s\S]*))?$/i);
  return match ? { focus: cleanString(match[1]) } : null;
}

export function buildFeishuReviewCommandPrompt(
  db: RunnerDatabase,
  input: FeishuReviewPromptInput
): string {
  return [
    "Feishu /review command: review the recent active conversation.",
    "Reply briefly and naturally in Chinese unless the user's recent language is clearly not Chinese.",
    "Use exactly these three section headings: 记忆候选, 待办候选, 需要你确认/授权的事项.",
    "Memory candidates: only call memory_write_candidate for durable, user-confirmable observations; it creates disabled pending candidates only. Never approve memory.",
    "Todo candidates: list possible runner issues as candidates in text only. Do not create or enqueue runner issues.",
    "Confirmation items: list unfinished questions, missing details, or actions needing user authorization.",
    "Do not call issue_create_proposal, issue_enqueue_proposal, issue_schedule_enqueue, issue_enqueue_next_triage, or issue_enqueue_batch_triage.",
    "Do not expose local filesystem paths, tokens, credentials, or internal exception stacks; redact them if present.",
    `Active conversation: ${safeText(input.conversationId, 120)}`,
    `Current project: ${safeText(cleanString(input.projectId) || "(unresolved)", 120)}`,
    "Recent transcript:",
    transcriptBlock(db, input.conversationId)
  ].join("\n");
}

export function normalizeFeishuReviewReply(text: string): string {
  const safe = truncateRunes(redactReviewText(text), MAX_REVIEW_REPLY_RUNES);
  if (REVIEW_HEADINGS.every((heading) => safe.includes(heading))) return safe;
  return [
    "记忆候选",
    "- 暂无明确候选。",
    "",
    "待办候选",
    "- 暂无明确候选。",
    "",
    "需要你确认/授权的事项",
    safe === "" ? "- 暂无。" : `- ${safe}`
  ].join("\n");
}

function transcriptBlock(db: RunnerDatabase, conversationId: string): string {
  const conversation = getPiConversation(db, conversationId);
  if (!conversation) return "- （没有找到已持久化的对话记录）";
  const items = piConversationDetail(conversation).transcript.slice(-MAX_TRANSCRIPT_ITEMS);
  if (items.length === 0) return "- （没有可回顾的对话文本）";
  return items.map((item) =>
    `- ${safeText(item.role, 24)}: ${safeText(item.text, MAX_TRANSCRIPT_ITEM_RUNES)}`
  ).join("\n");
}

function redactReviewText(text: string): string {
  return redactSensitiveText(cleanString(text))
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .split(/\r?\n/)
    .filter((line) => !isStackLine(line))
    .join("\n")
    .trim();
}

function isStackLine(line: string): boolean {
  return /^\s*at\s+.*(?::\d+:\d+|\(.+:\d+:\d+\))/.test(line) || line.includes("node:internal");
}

function safeText(value: unknown, maxRunes: number): string {
  return truncateRunes(redactReviewText(String(value ?? "")), maxRunes).replace(/\s+/g, " ");
}

function truncateRunes(text: string, maxRunes: number): string {
  const runes = [...text];
  return runes.length <= maxRunes ? text : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
