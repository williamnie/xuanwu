import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  listPiMemoryItems,
  type PiMemoryItem
} from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";

export const PI_MEMORY_TOOL_NAMES = ["memory.search", "memory.write_candidate"] as const;

type MemoryToolName = (typeof PI_MEMORY_TOOL_NAMES)[number];
type MemoryContext = { bus?: EventBus; conversationID?: string; projectID?: string };
type MemoryExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

const memorySearchParams = Type.Object({
  include_candidates: Type.Optional(Type.Boolean()),
  query: optionalString,
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

const memoryWriteCandidateParams = Type.Object({
  confidence: optionalString,
  content: requiredText,
  kind: requiredText,
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

export function createPiMemoryTools(db: RunnerDatabase, context: MemoryContext = {}): ToolDefinition[] {
  return [
    memoryTool("memory.search", "Memory Search", "Search active PI memory items; candidates are opt-in.",
      memorySearchParams, (params) => searchMemory(db, context, params)),
    memoryTool("memory.write_candidate", "Memory Write Candidate",
      "Write a disabled PI memory candidate for later review; does not promote long-term memory directly.",
      memoryWriteCandidateParams, (params) => writeMemoryCandidate(db, context, params))
  ];
}

function searchMemory(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>
) {
  const scope = cleanString(input.scope) || "project";
  const items = listPiMemoryItems(db, {
    disabled: input.include_candidates ? undefined : 0,
    scope,
    scopeId: cleanString(input.scope_id) || defaultScopeID(scope, context)
  });
  return { items: filterByQuery(items, input.query).map(summaryItem) };
}

function writeMemoryCandidate(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memoryWriteCandidateParams>
): PiMemoryItem {
  const scope = cleanString(input.scope) || "project";
  const item = createPiMemoryItem(db, {
    id: crypto.randomUUID(),
    scope,
    scope_id: cleanString(input.scope_id) || defaultScopeID(scope, context),
    kind: input.kind,
    content: input.content,
    source_type: "pi.conversation",
    source_id: cleanString(context.conversationID),
    confidence: cleanString(input.confidence) || "medium",
    disabled: 1
  });
  publishMemoryCandidate(context.bus, item);
  return item;
}

function memoryTool<TParams extends TSchema>(
  name: MemoryToolName,
  label: string,
  description: string,
  parameters: TParams,
  executeMemory: MemoryExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      const details = executeMemory(params);
      return toolResult(details);
    }
  };
}

function filterByQuery(items: PiMemoryItem[], query: unknown): PiMemoryItem[] {
  const needle = cleanString(query).toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => `${item.kind}\n${item.content}`.toLowerCase().includes(needle));
}

function summaryItem(item: PiMemoryItem): PiMemoryItem {
  return item;
}

function defaultScopeID(scope: string, context: MemoryContext): string | undefined {
  if (scope === "" || scope === "project") return cleanString(context.projectID) || undefined;
  if (scope === "conversation") return cleanString(context.conversationID) || undefined;
  return undefined;
}

function publishMemoryCandidate(bus: EventBus | undefined, item: PiMemoryItem): void {
  bus?.publish(memoryCandidateEvent(item));
}

function memoryCandidateEvent(item: PiMemoryItem): AppEvent {
  return {
    type: "pi.memory_candidate",
    conversationId: item.source_id || undefined,
    projectId: item.scope === "project" ? item.scope_id : undefined,
    payload: JSON.stringify({ id: item.id, kind: item.kind, scope: item.scope, scope_id: item.scope_id }),
    created_at: item.updated_at
  };
}

function toolResult(details: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) ?? "null" }],
    details
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
