import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, type PiMemoryItem, type PiMemoryItemFilter } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "../pi/memoryPolicy.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuMemoryCandidateContext = {
  conversationId?: string;
  projectId?: string;
};

const NOTICE_LIMIT = 3;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function snapshotFeishuMemoryCandidates(
  db: RunnerDatabase,
  context: FeishuMemoryCandidateContext
): string[] {
  return relevantPendingCandidates(db, context).map((item) => item.id);
}

export function appendFeishuMemoryCandidateNotice(
  db: RunnerDatabase,
  context: FeishuMemoryCandidateContext,
  text: string,
  beforeIds: string[]
): string {
  const before = new Set(beforeIds);
  const candidates = relevantPendingCandidates(db, context)
    .filter((item) => !before.has(item.id))
    .filter((item) => !containsSensitiveMemoryContent(item.content));
  if (candidates.length === 0) return text;
  return `${text.trim()}\n\n${memoryNotice(candidates)}`;
}

function relevantPendingCandidates(
  db: RunnerDatabase,
  context: FeishuMemoryCandidateContext
): PiMemoryItem[] {
  const conversationId = cleanString(context.conversationId);
  return uniqueItems(scopeFilters(context).flatMap((filter) => listPiMemoryItems(db, filter)))
    .filter((item) => conversationId === "" || item.source_id === conversationId)
    .sort(memoryOrder);
}

function scopeFilters(context: FeishuMemoryCandidateContext): PiMemoryItemFilter[] {
  const filters: PiMemoryItemFilter[] = [];
  const conversationId = cleanString(context.conversationId);
  const projectId = cleanString(context.projectId);
  if (conversationId !== "") filters.push({ disabled: 1, scope: "conversation", scopeId: conversationId });
  if (projectId !== "") filters.push({ disabled: 1, scope: "project", scopeId: projectId });
  filters.push({ disabled: 1, scope: "global" });
  return filters;
}

function memoryNotice(candidates: PiMemoryItem[]): string {
  const visible = candidates.slice(0, NOTICE_LIMIT);
  const firstId = shortID(visible[0]?.id ?? "");
  return [
    "我可以记住这条偏好/习惯，但需要你确认后才会写入长期 memory：",
    ...visible.map(memoryLine),
    commandHint(firstId)
  ].join("\n");
}

function memoryLine(item: PiMemoryItem): string {
  return `- ${shortID(item.id)} [${safeText(item.scope, 24)} | ${safeText(item.kind, 40)}] ${safeText(item.content, 90)}`;
}

function commandHint(id: string): string {
  return `发送 /memory approve ${id} 确认，或 /memory reject ${id} 删除。`;
}

function memoryOrder(left: PiMemoryItem, right: PiMemoryItem): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function uniqueItems(items: PiMemoryItem[]): PiMemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function safeText(value: unknown, maxRunes: number): string {
  const safe = redactSensitiveText(cleanString(value))
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ");
  const runes = [...safe];
  return runes.length <= maxRunes ? safe : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function shortID(id: string): string {
  return id.slice(0, 8);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
