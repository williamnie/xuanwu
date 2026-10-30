import type { RunnerDatabase } from "../../db/database.ts";
import type { PiMemoryItem } from "../../db/repositories/pi.ts";
import { type PiMemoryContextItem, PiMemoryTruncationSummary, DEFAULT_MEMORY_LIMIT, MAX_MEMORY_LIMIT, DEFAULT_TOKEN_BUDGET, MAX_TOKEN_BUDGET, PiMemoryPromptContextInput, scopedIssueIDs } from "./memoryContext.ts";
import { formatMemoryLine } from "./memoryContextProjection.ts";

export function selectWithinBudget(items: PiMemoryContextItem[], itemLimit: number, tokenBudget: number) {
  const selected: PiMemoryContextItem[] = [];
  let tokenEstimate = 0;
  let truncated = items.length > itemLimit;
  let stoppedByTokenBudget = false;
  for (const item of items.slice(0, itemLimit)) {
    const remaining = tokenBudget - tokenEstimate;
    if (remaining <= 0) { stoppedByTokenBudget = true; truncated = true; break; }
    const next = fitItemToBudget(item, remaining);
    if (!next) { stoppedByTokenBudget = true; truncated = true; continue; }
    selected.push(next);
    tokenEstimate += next.token_estimate;
    truncated ||= next.truncated;
  }
  return { items: selected, stoppedByTokenBudget, tokenEstimate, truncated };
}

export function truncationSummary(
  items: PiMemoryContextItem[],
  selected: ReturnType<typeof selectWithinBudget>,
  itemLimit: number,
  tokenBudget: number
): PiMemoryTruncationSummary {
  const limitedCount = Math.min(items.length, itemLimit);
  const omittedByItemLimit = Math.max(0, items.length - itemLimit);
  const omittedByTokenBudget = selected.stoppedByTokenBudget ? limitedCount - selected.items.length : 0;
  const truncatedItemIds = selected.items.filter((item) => item.truncated).map((item) => item.id);
  return {
    omitted_by_item_limit: omittedByItemLimit,
    omitted_by_token_budget: omittedByTokenBudget,
    omitted_count: Math.max(0, items.length - selected.items.length),
    selected_count: selected.items.length,
    summary: truncationText(omittedByItemLimit, omittedByTokenBudget, truncatedItemIds.length, tokenBudget),
    token_budget: tokenBudget,
    total_candidates: items.length,
    truncated_item_ids: truncatedItemIds
  };
}

export function truncationText(itemLimitOmitted: number, budgetOmitted: number, truncatedItems: number, tokenBudget: number): string {
  const omitted = itemLimitOmitted + budgetOmitted;
  if (omitted === 0 && truncatedItems === 0) return `No truncation; token budget ${tokenBudget} was sufficient.`;
  return `${omitted} memory item(s) omitted and ${truncatedItems} item(s) shortened by token budget ${tokenBudget}.`;
}

export function fitItemToBudget(item: PiMemoryContextItem, tokenBudget: number): PiMemoryContextItem | null {
  const fullEstimate = itemTokenEstimate(item);
  if (fullEstimate <= tokenBudget) return { ...item, token_estimate: fullEstimate };
  // 经验中的适用条件、反例和版本必须一起保留，不能截成看似通用的修复建议。
  if (item.selection_stage !== "policy") return null;
  let low = 0;
  let high = [...item.content].length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...item, content: truncateRunes(item.content, middle), truncated: true };
    if (itemTokenEstimate(candidate) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  if (low <= 1) return null;
  const next = { ...item, content: truncateRunes(item.content, low), truncated: true };
  return { ...next, token_estimate: itemTokenEstimate(next) };
}

export function scopeKey(input: { scope: string; scopeId?: string }): string {
  return `${input.scope}:${input.scopeId || "runner"}`;
}

export function scopeRank(item: PiMemoryItem): number {
  if (item.scope === "issue") return 0;
  if (item.scope === "inbox") return 1;
  if (item.scope === "source") return 2;
  if (item.scope === "skill") return 3;
  if (item.scope === "conversation") return 4;
  if (item.scope === "session") return 5;
  if (item.scope === "project") return 6;
  if (item.scope === "global") return 7;
  return 8;
}

export function memoryLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_MEMORY_LIMIT;
  return Math.max(0, Math.min(value, MAX_MEMORY_LIMIT));
}

export function memoryTokenBudget(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_TOKEN_BUDGET;
  return Math.max(0, Math.min(value, MAX_TOKEN_BUDGET));
}

export function estimateTokens(value: string): number {
  return Math.ceil([...value].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 0.25 : 1), 0));
}

export function itemTokenEstimate(item: PiMemoryContextItem): number {
  // 工具返回完整 JSON，不能只给正文计费；CJK 也不能当成四字符一个 token。
  return Math.max(estimateTokens(formatMemoryLine(item)), estimateTokens(JSON.stringify({ ...item, token_estimate: 4000 })));
}

export function withIssueTask(db: RunnerDatabase, input: PiMemoryPromptContextInput): PiMemoryPromptContextInput {
  if (input.taskDescription || !input.projectID) return input;
  const descriptions = scopedIssueIDs(input).flatMap((id) => {
    const row = db.sqlite.query<{ title: string; description: string }, [number, string]>(
      "select substr(title,1,512) as title, substr(description,1,3584) as description from issues where id=? and project_id=?"
    ).get(id, input.projectID!);
    return row ? [`${row.title}\n${row.description}`] : [];
  });
  return { ...input, taskDescription: descriptions.join("\n").slice(0, 4096) };
}

export function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  if (runes.length <= maxRunes) return value;
  if (maxRunes <= 1) return "…";
  return `${runes.slice(0, maxRunes - 1).join("")}…`;
}

export function cleanScopeID(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" ? value.trim() : "";
}
