import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, rememberPiMemoryItem, type PiMemoryItem, type PiMemoryItemFilter } from "../db/repositories/pi.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import type { EventBus } from "../events/bus.ts";
import { containsSensitiveMemoryContent, retrievableMemoryContent, retrievableMemoryKind, reusableMemoryRejection } from "./memoryPolicy.ts";

export const PI_MEMORY_TOOL_NAMES = ["memory_search", "memory_remember"] as const;

type MemoryToolName = (typeof PI_MEMORY_TOOL_NAMES)[number];
type MemoryContext = PiActionContext & { projectID?: string };
type MemoryExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

const memorySearchParams = Type.Object({
  kind: optionalString,
  query: optionalString,
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

const memoryWriteCandidateParams = Type.Object({
  confidence: optionalString,
  content: requiredText,
  evidence_ref: optionalString,
  kind: Type.Union([
    Type.Literal("user_preference"),
    Type.Literal("project_preference"),
    Type.Literal("decision"),
    Type.Literal("debugging_pattern"),
    Type.Literal("resolution"),
    Type.Literal("workflow"),
    Type.Literal("constraint")
  ]),
  memory_key: Type.String({ minLength: 3, maxLength: 120, pattern: "^[a-z0-9][a-z0-9._:/-]+$" }),
  user_authorized: Type.Optional(Type.Boolean()),
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

export function createPiMemoryTools(db: RunnerDatabase, context: MemoryContext = {}): ToolDefinition[] {
  return [
    memoryTool("memory_search", "Memory Search", "Search active reusable Supervisor memory. Current Work, Run, and Issue status is never memory.",
      memorySearchParams, (params) => executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
        actionType: "memory.search",
        payload: params,
        projectID: defaultScopeID(cleanString(params.scope) || "project", context),
        execute: () => searchMemory(db, context, params)
      })),
    memoryTool("memory_remember", "Remember Reusable Experience",
      "Remember an explicit user preference/decision/workflow or an evidence-backed reusable bug root-cause and resolution. Never store current status, counts, queues, temporary commitments, or manager-cycle summaries. Stable memory_key updates an existing memory instead of appending duplicates.",
      memoryWriteCandidateParams, (params) => executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
        actionType: "memory.remember",
        payload: params,
        projectID: defaultScopeID(cleanString(params.scope) || "project", context),
        execute: () => rememberMemory(db, context, params)
      }))
  ];
}

function searchMemory(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>
) {
  const requestedScope = cleanString(input.scope);
  const scope = requestedScope || "project";
  const items = searchableScopes(scope, context, input, requestedScope === "")
    .flatMap((filter) => listPiMemoryItems(db, filter));
  return { items: filterMemoryItems(items, input).map(summaryItem) };
}

function rememberMemory(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memoryWriteCandidateParams>
): PiMemoryItem | { reason: string; rejected: true } {
  const scope = memoryWriteScope(context, input);
  const reason = reusableMemoryRejection({
    confidence: input.confidence,
    content: input.content,
    evidenceRef: input.evidence_ref,
    kind: input.kind,
    memoryKey: input.memory_key,
    scope,
    source: context.source,
    userAuthorized: input.user_authorized
  });
  if (reason) return { rejected: true, reason };
  const citation = citationFromEvidence(input.evidence_ref);
  return rememberPiMemoryItem(db, {
    ...citation,
    id: crypto.randomUUID(),
    scope,
    scope_id: cleanString(input.scope_id) || defaultScopeID(scope, context),
    kind: input.kind,
    content: input.content,
    memory_key: input.memory_key,
    layer: "long_term",
    source_type: memorySourceType(context.source),
    source_id: cleanString(context.conversationID),
    confidence: cleanString(input.confidence) || "medium",
    disabled: 0
  });
}

function memoryWriteScope(context: MemoryContext, input: Static<typeof memoryWriteCandidateParams>): string {
  const requested = cleanString(input.scope);
  if (requested !== "") return requested;
  return "project";
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

function filterMemoryItems(items: PiMemoryItem[], input: Static<typeof memorySearchParams>): PiMemoryItem[] {
  const kind = cleanString(input.kind);
  const visible = items.filter((item) => retrievableMemoryKind(item.kind) &&
    retrievableMemoryContent(item.kind, item.content) && !containsSensitiveMemoryContent(item.content));
  const typed = kind === "" ? visible : visible.filter((item) => item.kind === kind);
  return filterByQuery(typed, input.query);
}

function searchableScopes(
  scope: string,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>,
  includeGlobalFallback: boolean
): PiMemoryItemFilter[] {
  const disabled = 0;
  const scopeId = cleanString(input.scope_id);
  if (scope !== "project" || scopeId !== "" || !includeGlobalFallback) {
    return [{
      disabled,
      scope,
      scopeId: scopeId || defaultScopeID(scope, context)
    }];
  }
  return [
    { disabled, scope: "project", scopeId: defaultScopeID("project", context) },
    { disabled, scope: "global", scopeId: defaultScopeID("global", context) }
  ];
}

function summaryItem(item: PiMemoryItem): PiMemoryItem {
  return item;
}

function defaultScopeID(scope: string, context: MemoryContext): string | undefined {
  if (scope === "conversation") return cleanString(context.conversationID) || undefined;
  if (scope === "global") return "runner";
  return cleanString(context.projectID) || "runner";
}

function memorySourceType(source: unknown): string {
  const text = cleanString(source);
  if (text === "pi_manager_cycle") return "pi.manager_cycle";
  if (text === "pi_supervisor_decision") return "pi.supervisor";
  return "pi.conversation";
}

function citationFromEvidence(value: unknown) {
  const reference = cleanString(value);
  if (reference === "") return {};
  const separator = reference.indexOf(":");
  return {
    citation_type: separator > 0 ? reference.slice(0, separator) : "evidence",
    citation_id: separator > 0 ? reference.slice(separator + 1) : reference,
    citation_label: "authoritative reusable-experience evidence"
  };
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatModelVisibleToolOutput(details, { source: "memory" }) }],
    details
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
