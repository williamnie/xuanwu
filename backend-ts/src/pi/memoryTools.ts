import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiMemoryItemByKey, rememberPiMemoryItem, type PiMemoryItem } from "../db/repositories/pi.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { containsSensitiveMemoryContent, reusableMemoryRejection } from "./memoryPolicy.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";
import type { MemoryScope } from "./memoryRetrieval.ts";
import { MEMORY_EXPERIENCE_INSTRUCTIONS, MEMORY_EXPERIENCE_SOURCE_INSTRUCTIONS, parseMemoryExperience } from "./memoryExperience.ts";
import { memoryEvidenceRejection } from "./memoryEvidence.ts";
import { PiMemoryWriteError } from "../db/repositories/pi/memoryHistory.ts";

export const PI_MEMORY_TOOL_NAMES = ["memory_search", "memory_remember"] as const;

type MemoryToolName = (typeof PI_MEMORY_TOOL_NAMES)[number];
type MemoryContext = PiActionContext & { projectID?: string; issueID?: number };
type MemoryExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

const memorySearchParams = Type.Object({
  kind: optionalString,
  query: Type.Optional(Type.String({ maxLength: 4096 })),
  task_description: Type.Optional(Type.String({ maxLength: 4096 })),
  error_text: Type.Optional(Type.String({ maxLength: 4096 })),
  file_paths: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 8 })),
  version: Type.Optional(Type.String({ maxLength: 512 })),
  token_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 4000 })),
  selection: Type.Optional(Type.Array(Type.Object({
    id: requiredText,
    revision: Type.Integer({ minimum: 1 }),
    content_fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reason: Type.String({ minLength: 1, maxLength: 400, pattern: "\\S" })
  }, objectOptions), { maxItems: 3 })),
  scope: optionalString,
  scope_id: optionalString
}, objectOptions);

const memoryWriteCandidateParams = Type.Object({
  confidence: optionalString,
  content: Type.String({ minLength: 1, pattern: "\\S", description: MEMORY_EXPERIENCE_SOURCE_INSTRUCTIONS }),
  evidence_ref: Type.Optional(Type.String({ description: "Typed source reference, not a bare canonical ID. During reflection, omit this optional field or copy an evidence:<canonical-id> reference from content.verification.evidence_refs exactly." })),
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
    memoryTool("memory_search", "Memory Search", "Search bounded active memory using query or task_description, error_text, file_paths and version. Technical experience requires matching project, applies_when and version; at most 3 text candidates, within token_budget. Check all applicability conditions, version and counterexamples using the current Pi model. Optionally repeat the same search context with selection [{id,revision,content_fingerprint,reason}] to select applicable candidates (or [] for none). Host rechecks scope, revision and suppression. User policy retains its authority. Current Work, Run, Issue status and permissions are never memory.",
      memorySearchParams, (params) => executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
        actionType: "memory.search",
        payload: params,
        projectID: actionProjectID(params, context),
        issueID: context.issueID,
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
  let writeResult = "unknown";
  let elapsedMs: number | null = null;
  return executeSafePiAction(db, { ...context, source: context.source || "pi_memory_tool" }, {
    actionType: "memory.remember", payload: params, projectID: actionProjectID(params, context),
    issueID: context.issueID,
    execute: () => {
      const started = performance.now();
      try { return db.transaction(() => {
        const scope = cleanString(params.scope) || "project";
        const previous = getPiMemoryItemByKey(db, scope, cleanString(params.scope_id) || defaultScopeID(scope, context) || "", params.memory_key);
        const result = rememberMemory(db, context, params);
        writeResult = "rejected" in result ? "rejected" : !previous ? "created"
          : result.revision === previous.revision ? "unchanged" : "updated";
        return result;
      }).immediate(); }
      catch (error) {
        if (error instanceof PiMemoryWriteError) { writeResult = "rejected"; return { rejected: true, reason: error.message }; }
        throw error;
      }
      finally { elapsedMs = Math.max(0, performance.now() - started); }
    },
    resultForAudit: result => ({ ...(result as object), diagnostics: { write_result: writeResult, elapsed_ms: elapsedMs } })
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
  if (scope === "conversation" && cleanString(input.scope_id) && cleanString(input.scope_id) !== context.conversationID) {
    return { items: [], rejected: true, reason: "memory conversation scope mismatch" };
  }
  if (scope === "global" && cleanString(input.scope_id) && cleanString(input.scope_id) !== "runner") {
    return { items: [], rejected: true, reason: "memory global scope mismatch" };
  }
  if (!["project", "global", "conversation"].includes(scope)) {
    return { items: [], rejected: true, reason: "memory search scope is not bound to this runtime" };
  }
  const result = retrievePiMemoryContext(db, {
    projectID: context.projectID,
    conversationID: context.conversationID,
    scopes: searchableScopes(scope, context, input, requestedScope === ""),
    query: input.query,
    kind: input.kind,
    taskDescription: input.task_description,
    errorText: input.error_text,
    filePaths: input.file_paths,
    version: input.version,
    tokenBudget: input.token_budget,
    selection: input.selection
  });
  return { items: result.memory_items, limits: result.limits, retrieval: result.retrieval,
    truncation_summary: result.truncation_summary };
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

function searchableScopes(
  scope: string,
  context: MemoryContext,
  input: Static<typeof memorySearchParams>,
  includeGlobalFallback: boolean
): MemoryScope[] {
  const scopeId = cleanString(input.scope_id);
  if (scope !== "project" || scopeId !== "" || !includeGlobalFallback) {
    return [{
      scope,
      scopeId: scopeId || defaultScopeID(scope, context)
    }];
  }
  return [
    { scope: "project", scopeId: defaultScopeID("project", context) },
    { scope: "global", scopeId: defaultScopeID("global", context) }
  ];
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
