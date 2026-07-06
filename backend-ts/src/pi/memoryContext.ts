import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, type PiMemoryItem } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "./memoryPolicy.ts";

export type PiMemoryPromptContextInput = {
  conversationID?: string;
  issueID?: number;
  issueIDs?: number[];
  limit?: number;
  projectID?: string;
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
  memory_type: string;
  pinned: number;
  reference: string;
  scope: string;
  scope_id: string;
  source_id: string;
  source_type: string;
  updated_at: string;
};

const DEFAULT_MEMORY_LIMIT = 10;
const MAX_MEMORY_LIMIT = 24;

export function buildPiMemoryPromptContext(db: RunnerDatabase, input: PiMemoryPromptContextInput = {}): string {
  const items = collectPiMemoryContextItems(db, input);
  const lines = items.map(formatMemoryLine);
  return [
    "Confirmed PI memory:",
    lines.length > 0 ? lines.join("\n") : "- No confirmed memories for this scope.",
    "Memory rule: write new observations only via memory_write_candidate; only explicit low-risk user preferences from normal chat may auto-enable, and guesses or policy/workflow observations still require review."
  ].join("\n");
}

export function collectPiMemoryContextItems(
  db: RunnerDatabase,
  input: PiMemoryPromptContextInput = {}
): PiMemoryContextItem[] {
  const items = memoryScopeFilters(input).flatMap((filter) => listPiMemoryItems(db, filter));
  return uniqueMemoryItems(items)
    .filter((item) => !containsSensitiveMemoryContent(item.content))
    .sort(memoryOrder)
    .slice(0, memoryLimit(input.limit))
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
    memory_type: item.memory_type,
    pinned: item.pinned,
    reference: memoryReference(item),
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: item.source_id,
    source_type: item.source_type,
    updated_at: item.updated_at
  };
}

function formatMemoryLine(item: PiMemoryContextItem): string {
  return `- [${item.reference} | type=${item.memory_type} | layer=${item.layer} | ${item.scope}:${item.scope_id || "runner"} | ${sourceLabel(item)} | ${citationLabel(item)} | updated=${item.updated_at} | confidence=${item.confidence}] ${item.kind}: ${item.content}`;
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

function scopeRank(item: PiMemoryItem): number {
  if (item.scope === "issue") return 0;
  if (item.scope === "conversation") return 1;
  if (item.scope === "session") return 2;
  if (item.scope === "project") return 3;
  if (item.scope === "global") return 4;
  return 5;
}

function memoryLimit(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_MEMORY_LIMIT;
  return Math.max(0, Math.min(value, MAX_MEMORY_LIMIT));
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: string | undefined): string {
  return value?.trim() ?? "";
}
