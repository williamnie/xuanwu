import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  listPiMemoryItems,
  type PiMemoryItem,
  type PiMemoryItemFilter
} from "../db/repositories/pi.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { containsSensitiveMemoryContent, memoryRejectedResult } from "./memoryPolicy.ts";

export const PI_MEMORY_TOOL_NAMES = ["memory_search", "memory_write_candidate"] as const;

type MemoryToolName = (typeof PI_MEMORY_TOOL_NAMES)[number];
type MemoryContext = PiActionContext & { projectID?: string };
type MemoryExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

const memorySearchParams = Type.Object({
  include_candidates: Type.Optional(Type.Boolean()),
  kind: optionalString,
  query: optionalString,
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

const memoryWriteCandidateParams = Type.Object({
  confidence: optionalString,
  content: requiredText,
  kind: requiredText,
  user_authorized: Type.Optional(Type.Boolean()),
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

export function createPiMemoryTools(db: RunnerDatabase, context: MemoryContext = {}): ToolDefinition[] {
  return [
    memoryTool("memory_search", "Memory Search", "Search active PI memory items; candidates are opt-in.",
      memorySearchParams, (params) => executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
        actionType: "memory.search",
        payload: params,
        projectID: defaultScopeID(cleanString(params.scope) || "project", context),
        execute: () => searchMemory(db, context, params)
      })),
    memoryTool("memory_write_candidate", "Memory Write Candidate",
      "Write a PI memory candidate; explicit low-risk user preferences from normal chat may be enabled immediately, while other observations stay disabled for review.",
      memoryWriteCandidateParams, (params) => executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
        actionType: "memory.write_candidate",
        payload: params,
        projectID: defaultScopeID(cleanString(params.scope) || "project", context),
        execute: () => writeMemoryCandidate(db, context, params)
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

function writeMemoryCandidate(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memoryWriteCandidateParams>
): PiMemoryItem | { reason: string; rejected: true } {
  const rejected = memoryRejectedResult(input.content);
  if (rejected) return rejected;
  const scope = memoryWriteScope(context, input);
  const disabled = autoEnableExplicitUserPreference(context, input, scope) ? 0 : 1;
  const item = createPiMemoryItem(db, {
    id: crypto.randomUUID(),
    scope,
    scope_id: cleanString(input.scope_id) || defaultScopeID(scope, context),
    kind: input.kind,
    content: input.content,
    source_type: memorySourceType(context.source),
    source_id: cleanString(context.conversationID),
    confidence: cleanString(input.confidence) || "medium",
    disabled
  });
  if (item.disabled === 1) publishMemoryCandidate(context.bus, item);
  return item;
}

function memoryWriteScope(context: MemoryContext, input: Static<typeof memoryWriteCandidateParams>): string {
  const requested = cleanString(input.scope);
  if (requested !== "") return requested;
  const content = cleanString(input.content);
  if (normalChatSource(context.source) && lowRiskPreferenceKind(input.kind) &&
    explicitNamingPreference(content) && !unsafeAutoEnableContent(content)) return "global";
  return "project";
}

function autoEnableExplicitUserPreference(
  context: MemoryContext,
  input: Static<typeof memoryWriteCandidateParams>,
  scope: string
): boolean {
  if (cleanString(context.conversationID) === "") return false;
  if (!normalChatSource(context.source)) return false;
  if (!["global", "conversation"].includes(scope)) return false;
  if (!lowRiskPreferenceKind(input.kind)) return false;
  if (!explicitAuthorization(input)) return false;
  const content = cleanString(input.content);
  return explicitNamingPreference(content) && !unsafeAutoEnableContent(content);
}

function explicitAuthorization(input: Static<typeof memoryWriteCandidateParams>): boolean {
  const confidence = cleanString(input.confidence).toLowerCase();
  return input.user_authorized === true || confidence === "" || confidence === "medium" || confidence === "high";
}

function normalChatSource(source: unknown): boolean {
  const text = cleanString(source);
  return text === "feishu_runner_chat" || text === "runner_chat";
}

function lowRiskPreferenceKind(kind: string): boolean {
  return ["preference", "user_preference", "personal_preference"].includes(cleanString(kind).toLowerCase());
}

function explicitNamingPreference(content: string): boolean {
  const text = content.toLowerCase();
  return /把我叫|叫我|叫他|叫她|称呼我|称呼用户为|称呼助手为|请叫我|以后叫我|你叫|助手叫|助理叫|你的名字是|call me|call the user|address me as|refer to me as|assistant name|assistant should be called|your name is/.test(text);
}

function projectOrPolicyLike(content: string): boolean {
  const text = content.toLowerCase();
  return /项目|团队|策略|规范|工作流|仓库|提交|部署|审批|授权|project|team|policy|workflow|repo|repository|commit|deploy|approval/.test(text);
}

function unsafeAutoEnableContent(content: string): boolean {
  return containsSensitiveMemoryContent(content) || absolutePathLike(content) || stackLineLike(content) ||
    inferredOrUncertain(content) || projectOrPolicyLike(content);
}

function absolutePathLike(content: string): boolean {
  return /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/.test(content);
}

function stackLineLike(content: string): boolean {
  return content.split(/\r?\n/).some((line) =>
    /^\s*at\s+.*(?::\d+:\d+|\(.+:\d+:\d+\))/.test(line) || line.includes("node:internal"));
}

function inferredOrUncertain(content: string): boolean {
  const text = content.toLowerCase();
  return /可能|也许|大概|似乎|推断|猜测|不确定|maybe|might|probably|seems|guess|infer/.test(text);
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
  const visible = items.filter((item) => !containsSensitiveMemoryContent(item.content));
  const typed = kind === "" ? visible : visible.filter((item) => item.kind === kind);
  return filterByQuery(typed, input.query);
}

function searchableScopes(
  scope: string,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>,
  includeGlobalFallback: boolean
): PiMemoryItemFilter[] {
  const disabled = input.include_candidates ? undefined : 0;
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

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) ?? "null" }],
    details
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
