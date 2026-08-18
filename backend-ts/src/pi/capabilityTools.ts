import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import type { AssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";

export const PI_CAPABILITY_TOOL_NAMES = ["capability_search", "capability_invoke", "context_status"] as const;

type CapabilityContext = { conversationID?: string };

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
  const searchable = snapshot.tools.filter((tool) => byName.has(tool.name) &&
    !PI_CAPABILITY_TOOL_NAMES.includes(tool.name as never));
  return [
    {
      name: "capability_search",
      label: "Capability Search",
      description: "Search the authorized tool registry for a capability. Returns bounded metadata and schema hashes; it does not execute or authorize a tool.",
      parameters: searchSchema,
      async execute(_toolCallId, params) {
        const query = params.query.trim().toLowerCase();
        const limit = params.limit ?? 6;
        const candidates = searchable.filter((tool) =>
          `${tool.provider_id}:${tool.name}\n${tool.description}`.toLowerCase().includes(query));
        const matches = candidates.slice(0, limit)
          .map((tool) => ({
            description: bounded(tool.description, 240),
            permission: tool.permission,
            schema_hash: schemaHash(tool.input_schema),
            tool_id: `${tool.provider_id}:${tool.name}`
          }));
        return toolResult({ matches, query, truncated: candidates.length > limit });
      }
    },
    {
      name: "capability_invoke",
      label: "Capability Invoke",
      description: "Invoke one exact capability returned by capability_search. The current registry schema and the target tool's existing permission and Action Gate remain authoritative.",
      parameters: invokeSchema,
      async execute(toolCallId, params, signal, onUpdate, extensionContext) {
        const target = findTarget(snapshot, params.tool_id);
        if (!target) return toolResult({ error: "capability_not_found", status: "failed" }, true);
        const definition = byName.get(target.name);
        if (!definition) return toolResult({ error: "capability_not_executable", status: "failed" }, true);
        const currentHash = schemaHash(target.input_schema);
        if (currentHash !== params.schema_hash) {
          return toolResult({ current_schema_hash: currentHash, error: "capability_schema_changed", status: "failed" }, true);
        }
        if (!Value.Check(definition.parameters, params.arguments)) {
          const errors = [...Value.Errors(definition.parameters, params.arguments)].slice(0, 8)
            .map((error) => ({ message: error.message, path: error.path || "/" }));
          return toolResult({ error: "capability_arguments_invalid", errors, status: "failed" }, true);
        }
        return await definition.execute(toolCallId, params.arguments, signal, onUpdate, extensionContext);
      }
    },
    {
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
    }
  ];
}

function findTarget(snapshot: AssistantToolRegistrySnapshot, id: string) {
  const separator = id.indexOf(":");
  if (separator <= 0) return undefined;
  const providerID = id.slice(0, separator);
  const name = id.slice(separator + 1);
  return snapshot.tools.find((tool) => tool.provider_id === providerID && tool.name === name);
}

function schemaHash(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(schema ?? {})).digest("hex");
}

function toolResult(details: unknown, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatModelVisibleToolOutput(details, { source: "capability" }) }],
    details,
    isError
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
