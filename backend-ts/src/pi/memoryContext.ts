import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, type PiMemoryItem } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent, retrievableMemoryContent, retrievableMemoryKind } from "./memoryPolicy.ts";

export type PiMemoryPromptContextInput = {
  conversationID?: string;
  inboxItemID?: number | string;
  issueID?: number;
  issueIDs?: number[];
  limit?: number;
  projectID?: string;
  skillID?: string;
  sourceID?: string;
  tokenBudget?: number;
};
export type PiMemoryContextItem = {
  confidence: string;
  content: string;
  citation_id: string;
  citation_label: string;
  citation_type: string;
  citation_url: string;
  id: string;
  kind: string;
  layer: string;
  last_seen_at: string;
  memory_key: string;
  memory_type: string;
  occurrence_count: number;
  pinned: number;
  provenance: PiMemoryProvenance;
  reference: string;
  retrieval_scope: string;
  selection_reason: string;
  scope: string;
  scope_id: string;
  source_id: string;
  source_path: string;
  source_type: string;
  token_estimate: number;
  truncated: boolean;
  updated_at: string;
};
export type PiMemoryProvenance = {
  citation_id: string;
  citation_label: string;
  citation_type: string;
  citation_url: string;
  reference: string;
  source_id: string;
  source_path: string;
  source_type: string;
};
export type PiMemoryRetrievalLimits = {
  item_limit: number;
  token_budget: number;
  token_estimate: number;
  truncated: boolean;
};
export type PiMemoryTruncationSummary = {
  omitted_by_item_limit: number;
  omitted_by_token_budget: number;
  omitted_count: number;
  selected_count: number;
  summary: string;
  token_budget: number;
  total_candidates: number;
  truncated_item_ids: string[];
};
export type PiMemoryRetrievalResult = {
  memory_items: PiMemoryContextItem[];
  retrieval_scopes: string[];
  limits: PiMemoryRetrievalLimits;
  truncation_summary: PiMemoryTruncationSummary;
};

const DEFAULT_MEMORY_LIMIT = 10;
const MAX_MEMORY_LIMIT = 24;
const DEFAULT_TOKEN_BUDGET = 900;
const MAX_TOKEN_BUDGET = 4000;
const APPROX_CHARS_PER_TOKEN = 4;

export function buildPiMemoryPromptContext(db: RunnerDatabase, input: PiMemoryPromptContextInput = {}): string {
  const result = retrievePiMemoryContext(db, input);
  const items = result.memory_items;
  const lines = items.map(formatMemoryLine);
  return [
    "Reusable Supervisor memory (non-authoritative context):",
    lines.length > 0 ? lines.join("\n") : "- No confirmed memories for this scope.",
    `Memory retrieval: scopes=${result.retrieval_scopes.join(",") || "global"} item_limit=${result.limits.item_limit} token_budget=${result.limits.token_budget} token_estimate=${result.limits.token_estimate} truncated=${result.limits.truncated}.`,
    `Memory truncation: ${result.truncation_summary.summary}`,
    "Memory rule: use memory_remember only for explicit preferences/decisions/workflows or evidence-backed root-cause and resolution experience. Never store or answer current Work/Run/Issue status from memory; always query authoritative tools for current state."
  ].join("\n");
}

export function retrievePiMemoryContext(
  db: RunnerDatabase,
  input: PiMemoryPromptContextInput = {}
): PiMemoryRetrievalResult {
  const itemLimit = memoryLimit(input.limit);
  const tokenBudget = memoryTokenBudget(input.tokenBudget);
  const candidates = rawMemoryContextItems(db, input);
  const selected = selectWithinBudget(candidates, itemLimit, tokenBudget);
  return {
    limits: {
      item_limit: itemLimit,
      token_budget: tokenBudget,
      token_estimate: selected.tokenEstimate,
      truncated: selected.truncated
    },
    memory_items: selected.items,
    retrieval_scopes: memoryScopeFilters(input).map(scopeKey),
    truncation_summary: truncationSummary(candidates, selected, itemLimit, tokenBudget)
  };
}

export function collectPiMemoryContextItems(
  db: RunnerDatabase,
  input: PiMemoryPromptContextInput = {}
): PiMemoryContextItem[] {
  return retrievePiMemoryContext(db, input).memory_items;
}

function rawMemoryContextItems(
  db: RunnerDatabase,
  input: PiMemoryPromptContextInput
): PiMemoryContextItem[] {
  const items = memoryScopeFilters(input).flatMap((filter) => listPiMemoryItems(db, filter));
  return uniqueMemoryItems(items)
    .filter((item) => retrievableMemoryKind(item.kind))
    .filter((item) => retrievableMemoryContent(item.kind, item.content))
    .filter((item) => !containsSensitiveMemoryContent(item.content))
    .sort(memoryOrder)
    .map(contextItem);
}

function memoryOrder(left: PiMemoryItem, right: PiMemoryItem): number {
  return scopeRank(left) - scopeRank(right) ||
    right.pinned - left.pinned ||
    right.updated_at.localeCompare(left.updated_at) ||
    left.id.localeCompare(right.id);
}

function memoryScopeFilters(input: PiMemoryPromptContextInput) {
  const filters: Array<{ disabled: number; scope: string; scopeId?: string }> = [];
  for (const issueID of scopedIssueIDs(input)) filters.push({ disabled: 0, scope: "issue", scopeId: String(issueID) });
  const conversationID = cleanString(input.conversationID);
  if (conversationID !== "") filters.push({ disabled: 0, scope: "conversation", scopeId: conversationID });
  const inboxItemID = cleanScopeID(input.inboxItemID);
  if (inboxItemID !== "") filters.push({ disabled: 0, scope: "inbox", scopeId: inboxItemID });
  const sourceID = cleanString(input.sourceID);
  if (sourceID !== "") filters.push({ disabled: 0, scope: "source", scopeId: sourceID });
  const skillID = cleanString(input.skillID);
  if (skillID !== "") filters.push({ disabled: 0, scope: "skill", scopeId: skillID });
  const projectID = cleanString(input.projectID);
  if (projectID !== "") filters.push({ disabled: 0, scope: "project", scopeId: projectID });
  filters.push({ disabled: 0, scope: "global" });
  return filters;
}

function scopedIssueIDs(input: PiMemoryPromptContextInput): number[] {
  const ids = [positiveInteger(input.issueID), ...(input.issueIDs ?? []).map(positiveInteger)];
  return [...new Set(ids.filter((id) => id > 0))];
}

function uniqueMemoryItems(items: PiMemoryItem[]): PiMemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function contextItem(item: PiMemoryItem): PiMemoryContextItem {
  const reference = memoryReference(item);
  return {
    confidence: item.confidence,
    content: item.content,
    citation_id: item.citation_id,
    citation_label: item.citation_label,
    citation_type: item.citation_type,
    citation_url: item.citation_url,
    id: item.id,
    kind: item.kind,
    layer: item.layer,
    last_seen_at: item.last_seen_at,
    memory_key: item.memory_key,
    memory_type: item.memory_type,
    occurrence_count: item.occurrence_count,
    pinned: item.pinned,
    provenance: memoryProvenance(item, reference),
    reference,
    retrieval_scope: scopeKey({ scope: item.scope, scopeId: item.scope_id }),
    selection_reason: selectionReason(item),
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: item.source_id,
    source_path: reference,
    source_type: item.source_type,
    token_estimate: estimateTokens(formatMemoryLine({ ...item, reference, retrieval_scope: "", source_path: reference, token_estimate: 0, truncated: false })),
    truncated: false,
    updated_at: item.updated_at
  };
}

function memoryProvenance(item: PiMemoryItem, reference: string): PiMemoryProvenance {
  return {
    citation_id: item.citation_id,
    citation_label: item.citation_label,
    citation_type: item.citation_type,
    citation_url: item.citation_url,
    reference,
    source_id: item.source_id,
    source_path: reference,
    source_type: item.source_type
  };
}

function selectionReason(item: PiMemoryItem): string {
  const base = `scope ${scopeKey({ scope: item.scope, scopeId: item.scope_id })} matched retrieval request`;
  return item.pinned === 1 ? `${base}; pinned memory ranked first` : `${base}; ranked by scope and freshness`;
}

function formatMemoryLine(item: PiMemoryContextItem): string {
  return `- [${item.reference} | memory_key=${item.memory_key} | seen=${item.occurrence_count} | last_seen=${item.last_seen_at} | source_path=${item.source_path} | type=${item.memory_type} | layer=${item.layer} | ${item.scope}:${item.scope_id || "runner"} | ${sourceLabel(item)} | ${citationLabel(item)} | updated=${item.updated_at} | confidence=${item.confidence}${item.truncated ? " | truncated=true" : ""}] ${item.kind}: ${item.content}`;
}

function sourceLabel(item: PiMemoryContextItem): string {
  const source = [item.source_type, item.source_id].filter(Boolean).join(":");
  return `source=${source || "unknown"}`;
}

function citationLabel(item: PiMemoryContextItem): string {
  const ref = [item.citation_type, item.citation_id].filter(Boolean).join(":");
  const label = item.citation_label || item.citation_url;
  return `citation=${[ref, label].filter(Boolean).join(" ") || "none"}`;
}

function memoryReference(item: PiMemoryItem): string {
  return `pi_memory_items/${item.id}`;
}

function selectWithinBudget(items: PiMemoryContextItem[], itemLimit: number, tokenBudget: number) {
  const selected: PiMemoryContextItem[] = [];
  let tokenEstimate = 0;
  let truncated = items.length > itemLimit;
  let stoppedByTokenBudget = false;
  for (const item of items.slice(0, itemLimit)) {
    const remaining = tokenBudget - tokenEstimate;
    if (remaining <= 0) { stoppedByTokenBudget = true; truncated = true; break; }
    const next = fitItemToBudget(item, remaining);
    if (!next) { stoppedByTokenBudget = true; truncated = true; break; }
    selected.push(next);
    tokenEstimate += next.token_estimate;
    truncated ||= next.truncated;
  }
  return { items: selected, stoppedByTokenBudget, tokenEstimate, truncated };
}

function truncationSummary(
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

function truncationText(itemLimitOmitted: number, budgetOmitted: number, truncatedItems: number, tokenBudget: number): string {
  const omitted = itemLimitOmitted + budgetOmitted;
  if (omitted === 0 && truncatedItems === 0) return `No truncation; token budget ${tokenBudget} was sufficient.`;
  return `${omitted} memory item(s) omitted and ${truncatedItems} item(s) shortened by token budget ${tokenBudget}.`;
}

function fitItemToBudget(item: PiMemoryContextItem, tokenBudget: number): PiMemoryContextItem | null {
  const fullEstimate = estimateTokens(formatMemoryLine(item));
  if (fullEstimate <= tokenBudget) return { ...item, token_estimate: fullEstimate };
  const budgetChars = tokenBudget * APPROX_CHARS_PER_TOKEN;
  const overhead = formatMemoryLine({ ...item, content: "", truncated: true }).length;
  const contentChars = Math.max(0, budgetChars - overhead - 1);
  if (contentChars <= 0) return null;
  const content = truncateRunes(item.content, contentChars);
  const next = { ...item, content, truncated: true };
  return { ...next, token_estimate: Math.min(tokenBudget, estimateTokens(formatMemoryLine(next))) };
}

function scopeKey(input: { scope: string; scopeId?: string }): string {
  return `${input.scope}:${input.scopeId || "runner"}`;
}

function scopeRank(item: PiMemoryItem): number {
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

function memoryLimit(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_MEMORY_LIMIT;
  return Math.max(0, Math.min(value, MAX_MEMORY_LIMIT));
}

function memoryTokenBudget(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_TOKEN_BUDGET;
  return Math.max(0, Math.min(value, MAX_TOKEN_BUDGET));
}

function estimateTokens(value: string): number {
  return Math.ceil([...value].length / APPROX_CHARS_PER_TOKEN);
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  if (runes.length <= maxRunes) return value;
  if (maxRunes <= 1) return "…";
  return `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function cleanScopeID(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" ? value.trim() : "";
}
