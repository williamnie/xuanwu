import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { AssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";
import { assistantToolRuntimePolicy, type AssistantTool } from "./toolProviderEnvelope.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "./toolCallAudit.ts";

export const PI_CAPABILITY_TOOL_NAMES = ["capability_search", "capability_invoke", "context_status"] as const;

type CapabilityContext = Partial<ToolCallAuditContext> & { conversationID?: string };

const searchSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: 8, minimum: 1 })),
  query: Type.String({ minLength: 1, maxLength: 200 })
}, { additionalProperties: false });

const invokeSchema = Type.Object({
  arguments: Type.Record(Type.String(), Type.Any()),
  schema_hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
  tool_id: Type.String({ minLength: 3, maxLength: 240 })
}, { additionalProperties: false });

export function createPiCapabilityTools(
  db: RunnerDatabase,
  context: CapabilityContext,
  snapshot: AssistantToolRegistrySnapshot,
  definitions: ToolDefinition[]
): ToolDefinition[] {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const searchable = snapshot.tools.filter((tool) => executableDefinition(tool, snapshot, byName) &&
    !PI_CAPABILITY_TOOL_NAMES.includes(tool.name as never));
  return [
    defineTool({
      name: "capability_search",
      label: "Capability Search",
      description: "Search the authorized tool registry for a capability. Returns bounded metadata and schema hashes; it does not execute or authorize a tool.",
      parameters: searchSchema,
      async execute(_toolCallId, params) {
        const query = params.query.trim();
        const limit = params.limit ?? 6;
        const candidates = searchable.map((tool) => ({ score: capabilityScore(tool, query), tool }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score || toolID(left.tool).localeCompare(toolID(right.tool)));
        const matches = candidates.slice(0, limit)
          .map(({ score, tool }) => ({
            description: bounded(tool.description, 240),
            family: assistantToolRuntimePolicy(tool).family,
            label: clean(tool.metadata?.label) || tool.name,
            name: tool.name,
            parameter_summary: parameterSummary(tool.input_schema),
            permission: tool.permission,
            provider_id: tool.provider_id,
            required_parameters: requiredParameters(tool.input_schema),
            risk_level: assistantToolRuntimePolicy(tool).risk_level,
            schema_hash: schemaHash(tool.input_schema),
            score,
            tool_id: toolID(tool)
          }));
        return toolResult({ matches, query, truncated: candidates.length > limit });
      }
    }),
    defineTool({
      name: "capability_invoke",
      label: "Capability Invoke",
      description: "Invoke one exact capability returned by capability_search. The current registry schema and the target tool's existing permission and Action Gate remain authoritative.",
      parameters: invokeSchema,
      async execute(toolCallId, params, signal, onUpdate, extensionContext) {
        const target = findTarget(snapshot, params.tool_id);
        if (!target) return toolResult({ error: "capability_not_found", status: "failed" });
        const definition = executableDefinition(target, snapshot, byName);
        if (!definition) return toolResult({ error: "capability_not_executable", status: "failed" });
        const currentHash = schemaHash(target.input_schema);
        if (currentHash !== params.schema_hash) {
          return toolResult({ current_schema_hash: currentHash, error: "capability_schema_changed", status: "failed" });
        }
        if (!Value.Check(definition.parameters, params.arguments)) {
          const errors = [...Value.Errors(definition.parameters, params.arguments)].slice(0, 8)
            .map((error) => ({ message: error.message, path: error.instancePath || "/" }));
          return toolResult({ error: "capability_arguments_invalid", errors, status: "failed" });
        }
        const started = Date.now();
        const targetToolCallID = `${toolCallId}:target:${createHash("sha256").update(params.tool_id).digest("hex").slice(0, 12)}`;
        try {
          const result = await definition.execute(targetToolCallID, params.arguments, signal, onUpdate, extensionContext);
          const failed = toolResultFailed(result);
          recordTargetAudit(db, context, target, targetToolCallID, params.arguments, started, result.details, failed
            ? { message: toolResultText(result), type: "tool_error" }
            : undefined);
          return result;
        } catch (error) {
          recordTargetAudit(db, context, target, targetToolCallID, params.arguments, started, undefined, {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof Error && error.name ? error.name : "tool_error"
          });
          throw error;
        }
      }
    }),
    defineTool({
      name: "context_status",
      label: "Context Status",
      description: "Read the latest observe-only PI context budget snapshot for this conversation.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const latest = safeJson(db.sqlite.query<{ payload_json: string }, [string]>(`
          select payload_json from pi_action_events
          where conversation_id=? and event_type='runtime_context_budget_observed'
            and json_valid(payload_json) and json_extract(payload_json, '$.phase')='preflight'
          order by id desc limit 1
        `).get(clean(context.conversationID))?.payload_json ?? "{}");
        return toolResult({
          breakdown: record(latest.breakdown),
          context: record(latest.context),
          counts: record(latest.counts),
          observe_only: true,
          surface: clean(latest.surface)
        });
      }
    })
  ];
}

function findTarget(snapshot: AssistantToolRegistrySnapshot, id: string) {
  const separator = id.indexOf(":");
  if (separator <= 0) return undefined;
  const providerID = id.slice(0, separator);
  const name = id.slice(separator + 1);
  return snapshot.tools.find((tool) => tool.provider_id === providerID && tool.name === name);
}

function executableDefinition(
  target: AssistantTool,
  snapshot: AssistantToolRegistrySnapshot,
  byName: Map<string, ToolDefinition>
): ToolDefinition | undefined {
  const definition = byName.get(target.name);
  if (!definition) return undefined;
  if (target.provider_id === "runner-builtin") return definition;
  const builtinCollision = snapshot.tools.some((tool) =>
    tool.provider_id === "runner-builtin" && tool.name === target.name);
  return builtinCollision ? undefined : definition;
}

function capabilityScore(tool: AssistantTool, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery === "") return 0;
  const policy = assistantToolRuntimePolicy(tool);
  const id = normalizeSearchText(toolID(tool));
  const name = normalizeSearchText(tool.name);
  const aliases = policy.aliases.map(normalizeSearchText).filter(Boolean);
  if (normalizedQuery === id) return 1_000;
  if (normalizedQuery === name) return 980;
  if (aliases.includes(normalizedQuery)) return 940;
  if (aliases.some((alias) => normalizedQuery.includes(alias) || alias.includes(normalizedQuery))) return 900;
  const fields = normalizeSearchText([
    tool.provider_id,
    tool.name,
    clean(tool.metadata?.label),
    tool.description,
    policy.family,
    ...policy.aliases
  ].join(" "));
  const queryTokens = searchTokens(normalizedQuery);
  if (queryTokens.length === 0) return fields.includes(normalizedQuery) ? 600 : 0;
  const matched = queryTokens.filter((token) => fields.includes(token));
  if (matched.length === 0) return 0;
  const coverage = matched.length / queryTokens.length;
  return Math.round(200 + coverage * 500 + Math.min(matched.length, 8) * 10);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_:./-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const SEARCH_STOP_WORDS = new Set(["a", "an", "the", "for", "to", "when", "it", "is", "of", "all"]);

function searchTokens(value: string): string[] {
  return [...new Set(value.split(" ").map(stemEnglishToken)
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)))];
}

function stemEnglishToken(value: string): string {
  if (!/^[a-z]+$/.test(value) || value.length <= 4) return value;
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ing") && value.length > 6) return value.slice(0, -3);
  if (value.endsWith("ed") && value.length > 5) return value.slice(0, -2);
  if (value.endsWith("es") && value.length > 5) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 4) return value.slice(0, -1);
  return value;
}

function requiredParameters(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.map(clean).filter(Boolean).slice(0, 16)
    : [];
}

function parameterSummary(schema: Record<string, unknown>): Record<string, string> {
  const properties = record(schema.properties);
  return Object.fromEntries(Object.entries(properties).slice(0, 16)
    .map(([name, value]) => [name, schemaType(record(value))]));
}

function schemaType(schema: Record<string, unknown>): string {
  const enumValues = Array.isArray(schema.enum) ? schema.enum.map(String).slice(0, 8) : [];
  if (enumValues.length > 0) return `enum(${enumValues.join("|")})`;
  const type = clean(schema.type) || (Array.isArray(schema.anyOf) ? "union" : "unknown");
  if (type === "array") return `array<${schemaType(record(schema.items))}>`;
  return type;
}

function recordTargetAudit(
  db: RunnerDatabase,
  context: CapabilityContext,
  target: AssistantTool,
  toolCallID: string,
  args: unknown,
  started: number,
  output: unknown,
  error?: { message: string; type: string }
): void {
  recordToolCallAuditEvent(db, {
    conversationID: clean(context.conversationID),
    delegationID: clean(context.delegationID),
    heartbeatID: clean(context.heartbeatID),
    issueID: context.issueID,
    projectID: clean(context.projectID),
    source: clean(context.source) || "capability_invoke"
  }, {
    args,
    durationMs: Date.now() - started,
    error,
    output,
    permission: target.permission,
    providerID: target.provider_id,
    status: error ? "failed" : "succeeded",
    toolCallID,
    toolName: target.name
  });
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n") || "Tool execution failed";
}

function toolResultFailed(result: AgentToolResult<unknown>): boolean {
  const details = record(result.details);
  return details.status === "failed" || details.status === "denied" || typeof details.error === "string";
}

function toolID(tool: Pick<AssistantTool, "name" | "provider_id">): string {
  return `${tool.provider_id}:${tool.name}`;
}

function schemaHash(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(schema ?? {})).digest("hex");
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatModelVisibleToolOutput(details, { source: "tool_output" }) }],
    details
  };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
