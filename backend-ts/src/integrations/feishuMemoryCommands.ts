import type { RunnerDatabase } from "../db/database.ts";
import {
  deletePiMemoryItem,
  listPiMemoryItems,
  updatePiMemoryItem,
  type PiMemoryItem,
  type PiMemoryItemFilter
} from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "../pi/memoryPolicy.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuMemoryCommandInput = {
  conversationId?: string;
  limit?: number;
  projectId?: string;
  text: string;
};
export type FeishuMemoryCommandResult = {
  handled: boolean;
  reason: string;
  text: string;
};

type ParsedMemoryCommand =
  | { action: "approve" | "disable" | "reject"; id: string }
  | { action: "help" | "list"; query: string }
  | { action: "search"; query: string }
  | { action: "none"; query: string };

const DEFAULT_LIST_LIMIT = 8;
const MAX_LIST_LIMIT = 20;
const ID_MIN_LENGTH = 4;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function applyFeishuMemoryCommand(
  db: RunnerDatabase,
  input: FeishuMemoryCommandInput
): FeishuMemoryCommandResult {
  const command = parseFeishuMemoryCommand(input.text);
  if (command.action === "none") return { handled: false, reason: "not_memory_command", text: "" };
  try {
    if (command.action === "approve") return approveMemoryCandidate(db, input, command.id);
    if (command.action === "disable") return disableActiveMemory(db, input, command.id);
    if (command.action === "reject") return rejectMemoryCandidate(db, input, command.id);
    if (command.action === "search") return searchConfirmedMemory(db, input, command.query);
    if (command.action === "help") return handled("memory_command_usage", memoryUsageText());
    return listPendingCandidates(db, input);
  } catch {
    return handled("memory_command_failed", "处理 /memory 命令时出错了，请稍后重试。");
  }
}

function parseFeishuMemoryCommand(text: string): ParsedMemoryCommand {
  const match = cleanString(text).match(/^\/memory(?:\s+([\s\S]*))?$/i);
  if (!match) return { action: "none", query: "" };
  const args = cleanString(match[1]);
  if (args === "") return { action: "list", query: "" };
  const [rawVerb = "", ...rest] = args.split(/\s+/);
  const verb = rawVerb.toLowerCase();
  const body = cleanString(rest.join(" "));
  if (verb === "approve") return body === "" ? { action: "help", query: "" } : { action: "approve", id: body };
  if (verb === "disable") return body === "" ? { action: "help", query: "" } : { action: "disable", id: body };
  if (verb === "reject") return body === "" ? { action: "help", query: "" } : { action: "reject", id: body };
  if (verb === "search") return body === "" ? { action: "help", query: "" } : { action: "search", query: body };
  return { action: "help", query: "" };
}

function listPendingCandidates(db: RunnerDatabase, input: FeishuMemoryCommandInput): FeishuMemoryCommandResult {
  const items = scopedMemoryItems(db, input, 1).slice(0, memoryLimit(input.limit));
  if (items.length === 0) {
    return handled("memory_candidates_listed", "当前 conversation/project/global 没有待审核记忆候选。");
  }
  return handled("memory_candidates_listed", [
    `待审核记忆（最近 ${items.length} 条）：`,
    ...items.map(memoryLine),
    memoryUsageHint()
  ].join("\n"));
}

function approveMemoryCandidate(db: RunnerDatabase, input: FeishuMemoryCommandInput, id: string): FeishuMemoryCommandResult {
  const resolved = resolvePendingCandidate(scopedMemoryItems(db, input, 1), id);
  if (resolved.status !== "resolved") return handled(resolved.reason, resolved.text);
  if (containsSensitiveMemoryContent(resolved.item.content)) {
    return handled("memory_candidate_sensitive", `候选 ${shortID(resolved.item.id)} 含敏感内容，未确认。请先 /memory reject ${shortID(resolved.item.id)} 或人工重写。`);
  }
  const item = updatePiMemoryItem(db, resolved.item.id, { disabled: 0 });
  return handled("memory_candidate_approved", `已确认记忆 ${shortID(item.id)}（${scopeText(item)}，${safeText(item.kind, 40)}）。后续会按 scope 注入 Supervisor prompt。`);
}

function disableActiveMemory(db: RunnerDatabase, input: FeishuMemoryCommandInput, id: string): FeishuMemoryCommandResult {
  const resolved = resolveMemoryItem(scopedMemoryItems(db, input, 0), id, "已启用记忆");
  if (resolved.status !== "resolved") return handled(activeMemoryReason(resolved.reason), resolved.text);
  const item = updatePiMemoryItem(db, resolved.item.id, { disabled: 1 });
  return handled("memory_disabled", `已禁用记忆 ${shortID(item.id)}（${scopeText(item)}，${safeText(item.kind, 40)}）。后续不会注入 Supervisor prompt。`);
}

function rejectMemoryCandidate(db: RunnerDatabase, input: FeishuMemoryCommandInput, id: string): FeishuMemoryCommandResult {
  const resolved = resolvePendingCandidate(scopedMemoryItems(db, input, 1), id);
  if (resolved.status !== "resolved") return handled(resolved.reason, resolved.text);
  deletePiMemoryItem(db, resolved.item.id);
  return handled("memory_candidate_rejected", `已删除候选记忆 ${shortID(resolved.item.id)}，后续不会注入 Supervisor prompt。`);
}

function searchConfirmedMemory(
  db: RunnerDatabase,
  input: FeishuMemoryCommandInput,
  query: string
): FeishuMemoryCommandResult {
  const needle = query.toLowerCase();
  const items = scopedMemoryItems(db, input, 0)
    .filter((item) => !containsSensitiveMemoryContent(item.content))
    .filter((item) => `${item.kind}\n${item.content}`.toLowerCase().includes(needle))
    .slice(0, memoryLimit(input.limit));
  if (items.length === 0) return handled("memory_search_sent", "没有找到匹配关键词的已确认记忆。");
  return handled("memory_search_sent", [
    "已确认记忆搜索结果：",
    ...items.map(memoryLine)
  ].join("\n"));
}

function scopedMemoryItems(db: RunnerDatabase, input: FeishuMemoryCommandInput, disabled: number): PiMemoryItem[] {
  const items = scopeFilters(input, disabled).flatMap((filter) => listPiMemoryItems(db, filter));
  return uniqueItems(items).sort(memoryOrder);
}

function scopeFilters(input: FeishuMemoryCommandInput, disabled: number): PiMemoryItemFilter[] {
  const filters: PiMemoryItemFilter[] = [];
  const conversationId = cleanString(input.conversationId);
  const projectId = cleanString(input.projectId);
  if (conversationId !== "") filters.push({ disabled, scope: "conversation", scopeId: conversationId });
  if (projectId !== "") filters.push({ disabled, scope: "project", scopeId: projectId });
  filters.push({ disabled, scope: "global" });
  return filters;
}

function resolvePendingCandidate(items: PiMemoryItem[], id: string):
  | { item: PiMemoryItem; status: "resolved" }
  | { reason: string; status: "error"; text: string } {
  return resolveMemoryItem(items, id, "待审核候选");
}

function resolveMemoryItem(items: PiMemoryItem[], id: string, label: string):
  | { item: PiMemoryItem; status: "resolved" }
  | { reason: string; status: "error"; text: string } {
  const key = cleanString(id);
  if (key.length < ID_MIN_LENGTH) return { reason: "memory_candidate_invalid_id", status: "error", text: "请提供至少 4 位记忆 id。" };
  const matches = items.filter((item) => item.id === key || item.id.startsWith(key));
  if (matches.length === 0) return { reason: "memory_candidate_not_found", status: "error", text: `未找到${label}，请确认 id。` };
  if (matches.length > 1) return { reason: "memory_candidate_ambiguous", status: "error", text: `${label} id 匹配多条，请输入更长 id。` };
  return { item: matches[0], status: "resolved" };
}

function activeMemoryReason(reason: string): string {
  if (reason === "memory_candidate_not_found") return "memory_active_not_found";
  if (reason === "memory_candidate_ambiguous") return "memory_active_ambiguous";
  if (reason === "memory_candidate_invalid_id") return "memory_active_invalid_id";
  return reason;
}

function memoryLine(item: PiMemoryItem): string {
  return `- ${shortID(item.id)} [${scopeText(item)} | ${safeText(item.kind, 40)}] ${contentSummary(item)}`;
}

function contentSummary(item: PiMemoryItem): string {
  if (containsSensitiveMemoryContent(item.content)) return "内容包含敏感信息（已隐藏）";
  return safeText(item.content, 120);
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

function memoryLimit(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_LIST_LIMIT;
  return Math.max(0, Math.min(value, MAX_LIST_LIMIT));
}

function memoryUsageText(): string {
  return [
    "支持的 /memory 命令：",
    "- /memory：列出当前 conversation/project/global 的待审核候选",
    "- /memory approve <id>：确认候选",
    "- /memory disable <id>：禁用已启用记忆",
    "- /memory reject <id>：删除候选",
    "- /memory search <关键词>：搜索已确认记忆"
  ].join("\n");
}

function memoryUsageHint(): string {
  return "操作：/memory approve <id> 确认，/memory reject <id> 删除，/memory disable <id> 禁用已启用记忆，/memory search <关键词> 搜索已确认记忆。";
}

function handled(reason: string, text: string): FeishuMemoryCommandResult {
  return { handled: true, reason, text };
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

function scopeText(item: PiMemoryItem): string {
  return `${safeText(item.scope, 40)}:${safeText(item.scope_id || "runner", 60)}`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
