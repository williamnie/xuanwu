import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, type PiMemoryItem } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "./memoryPolicy.ts";

export type PiMemoryPromptContextInput = { limit?: number; projectID?: string };

const DEFAULT_MEMORY_LIMIT = 10;

export function buildPiMemoryPromptContext(db: RunnerDatabase, input: PiMemoryPromptContextInput = {}): string {
  const items = relevantMemories(db, input).slice(0, input.limit ?? DEFAULT_MEMORY_LIMIT);
  const lines = items.map(formatMemoryLine);
  return [
    "Confirmed PI memory:",
    lines.length > 0 ? lines.join("\n") : "- No confirmed memories for this scope.",
    "Memory rule: write new observations only via memory_write_candidate; never promote guesses without user review."
  ].join("\n");
}

function relevantMemories(db: RunnerDatabase, input: PiMemoryPromptContextInput): PiMemoryItem[] {
  const global = listPiMemoryItems(db, { disabled: 0, scope: "global" });
  const projectID = cleanString(input.projectID);
  const project = projectID === "" ? [] : listPiMemoryItems(db, { disabled: 0, scope: "project", scopeId: projectID });
  return [...project, ...global].filter((item) => !containsSensitiveMemoryContent(item.content)).sort(memoryOrder);
}

function memoryOrder(left: PiMemoryItem, right: PiMemoryItem): number {
  return right.pinned - left.pinned || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function formatMemoryLine(item: PiMemoryItem): string {
  return `- [${item.scope}:${item.scope_id}] ${item.kind} (${item.confidence}): ${item.content}`;
}

function cleanString(value: string | undefined): string {
  return value?.trim() ?? "";
}
