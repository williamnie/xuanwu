import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiMemoryItemByKey, listPiMemoryItems, rememberPiMemoryItem, type PiMemoryItem, type PiMemoryItemFilter } from "../db/repositories/pi.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { containsSensitiveMemoryContent, retrievableMemoryContent, retrievableMemoryKind, reusableMemoryRejection } from "./memoryPolicy.ts";
import { MEMORY_EXPERIENCE_INSTRUCTIONS, parseMemoryExperience } from "./memoryExperience.ts";
import { memoryEvidenceRejection } from "./memoryEvidence.ts";
import { PiMemoryWriteError } from "../db/repositories/pi/memoryHistory.ts";

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
  correction: Type.Optional(Type.Object({
    expected_revision: Type.Integer({ minimum: 1 }),
    disposition: Type.Union([Type.Literal("narrow"), Type.Literal("disable")]),
    reason: requiredText
  }, objectOptions)),
  reenable: Type.Optional(Type.Boolean()),
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
        projectID: actionProjectID(params, context),
        execute: () => searchMemory(db, context, params)
      })),
    memoryTool("memory_remember", "Remember Reusable Experience",
      `Remember an explicit user preference/decision/workflow or evidence-backed reusable experience. Never store secrets, current status, counts, queues or temporary commitments. Stable memory_key updates the same memory. ${MEMORY_EXPERIENCE_INSTRUCTIONS}`,
      memoryWriteCandidateParams, (params) => executePiMemoryRemember(db, context, params))
  ];
}

// 同步写入口供复盘租约事务复用；始终经过敏感数据保护、Action Gate 和来源校验。
export type PiMemoryRememberInput = Static<typeof memoryWriteCandidateParams>;
export function executePiMemoryRemember(db: RunnerDatabase, context: MemoryContext, params: PiMemoryRememberInput) {
  if (containsSensitiveMemoryContent(JSON.stringify(params))) {
    return { rejected: true, reason: "memory content contains sensitive data" };
  }
  return executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
    actionType: "memory.remember", payload: params, projectID: actionProjectID(params, context),
    execute: () => {
      try { return db.transaction(() => rememberMemory(db, context, params)).immediate(); }
      catch (error) {
        if (error instanceof PiMemoryWriteError) return { rejected: true, reason: error.message };
        throw error;
      }
    }
  });
}

function searchMemory(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>
) {
  const requestedScope = cleanString(input.scope);
  const scope = requestedScope || "project";
  if (projectScopeMismatch(scope, input.scope_id, context)) return { items: [], rejected: true, reason: "memory project scope mismatch" };
  const items = searchableScopes(scope, context, input, requestedScope === "")
    .flatMap((filter) => listPiMemoryItems(db, filter));
  return { items: filterMemoryItems(items, input).map(summaryItem) };
}

function rememberMemory(
  db: RunnerDatabase,
  context: MemoryContext,
  input: Static<typeof memoryWriteCandidateParams>
): PiMemoryItem | { reason: string; rejected: true } {
  const scope = cleanString(input.scope) || "project";
  const scopeID = cleanString(input.scope_id) || defaultScopeID(scope, context);
  if (projectScopeMismatch(scope, input.scope_id, context)) return { rejected: true, reason: "memory project scope mismatch" };
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
  const authority = ["pi_manager_cycle", "pi_memory_reflection"].includes(cleanString(context.source)) ? "evidence_backed" : "user_explicit";
  if (input.reenable && (authority !== "user_explicit" || input.user_authorized !== true)) {
    return { rejected: true, reason: "re-enable requires a separate explicit user request" };
  }
  const experience = authority === "evidence_backed" ? parseMemoryExperience(input.content) : undefined;
  if (authority === "evidence_backed") {
    const projectID = cleanString(context.projectID);
    if (!projectID || !experience) return { rejected: true, reason: "automatic experience requires a project and structured content" };
    if (getPiMemoryItemByKey(db, scope, scopeID || "", input.memory_key)?.authority === "user_explicit") {
      return { rejected: true, reason: "automatic experience cannot overwrite explicit user memory" };
    }
    const evidenceReason = memoryEvidenceRejection(db, projectID, experience, input.evidence_ref);
    if (evidenceReason) return { rejected: true, reason: evidenceReason };
  }
  const primaryRef = cleanString(input.evidence_ref) || experience?.verification.evidence_refs[0];
  const citation = citationFromEvidence(primaryRef);
  return rememberPiMemoryItem(db, {
    ...citation,
    id: crypto.randomUUID(),
    scope,
    scope_id: scopeID,
    kind: input.kind,
    content: experience ? JSON.stringify(experience) : input.content,
    memory_key: input.memory_key,
    layer: "long_term",
    source_type: memorySourceType(context.source),
    source_id: experience?.source.run_id || cleanString(context.conversationID),
    confidence: cleanString(input.confidence) || "medium",
    authority,
    authorized_at: new Date().toISOString(),
    authorized_by: authority === "user_explicit"
      ? cleanString(context.conversationID) || "explicit-user-statement"
      : cleanString(primaryRef),
    disabled: 0
  }, { correction: input.correction, reenable: input.reenable === true && input.user_authorized === true });
}

function projectScopeMismatch(scope: string, scopeID: unknown, context: MemoryContext): boolean {
  return scope === "project" && cleanString(scopeID) !== "" &&
    cleanString(scopeID) !== defaultScopeID("project", context);
}

function actionProjectID(input: { scope?: string; scope_id?: string }, context: MemoryContext): string | undefined {
  const scope = cleanString(input.scope) || "project";
  return scope === "project" ? cleanString(input.scope_id) || defaultScopeID(scope, context) : defaultScopeID(scope, context);
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
  if (text === "pi_memory_reflection") return "pi.memory_reflection";
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
