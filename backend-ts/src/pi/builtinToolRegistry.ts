import type { RunnerDatabase } from "../db/database.ts";
import { createPiProjectTools } from "../http/piProjectTools.ts";
import type { AssistantTool, ToolJsonSchema, ToolPermission, ToolProvider } from "./toolProviderEnvelope.ts";

export const RUNNER_BUILTIN_PROVIDER_ID = "runner-builtin";
const PRIMITIVE_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const READ_TOOL_NAMES = new Set<string>([
  ...PRIMITIVE_READ_TOOL_NAMES,
  "issue_list",
  "issue_status_summary",
  "issue_execution_status",
  "issue_read",
  "issue_state_diagnose",
  "issue_completion_watch_list",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "project_status",
  "project_list",
  "session_list",
  "session_read_summary",
  "skill_list",
  "skill_read",
  "skill_recommend",
  "mcp_registry_list",
  "mcp_capability_read",
  "mcp_requirement_recommend",
  "mcp_resource_list",
  "mcp_resource_read",
  "memory_search"
]);

export function listBuiltinToolProviders(): ToolProvider[] {
  return [{
    audit: { redact: [] },
    description: "Builtin PI and runner tools exposed by the local runtime.",
    id: RUNNER_BUILTIN_PROVIDER_ID,
    kind: "builtin",
    metadata: { builtin: true },
    name: "Runner builtin",
    status: "enabled"
  }];
}

export function listBuiltinAssistantTools(): AssistantTool[] {
  return [...primitiveReadTools(), ...piActionTools()].sort(compareTools);
}

function piActionTools(): AssistantTool[] {
  const tools = createPiProjectTools({} as RunnerDatabase);
  return tools.map((tool) => ({
    audit: { redact: [] },
    description: tool.description,
    input_schema: plainSchema(tool.parameters),
    metadata: { builtin: true, label: tool.label ?? tool.name },
    name: tool.name,
    output_schema: { type: "object" },
    permission: builtinToolPermission(tool.name),
    provider_id: RUNNER_BUILTIN_PROVIDER_ID
  }));
}

function primitiveReadTools(): AssistantTool[] {
  return PRIMITIVE_READ_TOOL_NAMES.map((name) => ({
    audit: { redact: [] },
    description: primitiveDescription(name),
    input_schema: primitiveSchema(name),
    metadata: { builtin: true, label: name },
    name,
    output_schema: { type: "object" },
    permission: "read",
    provider_id: RUNNER_BUILTIN_PROVIDER_ID
  }));
}

export function builtinToolPermission(name: string): ToolPermission {
  return READ_TOOL_NAMES.has(name) ? "read" : "write";
}

function primitiveDescription(name: string): string {
  if (name === "read") return "Read a bounded file excerpt through PI runtime.";
  if (name === "grep") return "Search text through PI runtime.";
  if (name === "find") return "Find files through PI runtime.";
  return "List directory entries through PI runtime.";
}

function primitiveSchema(name: string): ToolJsonSchema {
  if (name === "grep") return objectSchema({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]);
  if (name === "find") return objectSchema({ name: { type: "string" }, path: { type: "string" } });
  return objectSchema({ path: { type: "string" } }, ["path"]);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): ToolJsonSchema {
  return { additionalProperties: false, properties, required, type: "object" };
}

function plainSchema(value: unknown): ToolJsonSchema {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

function compareTools(left: AssistantTool, right: AssistantTool): number {
  return left.name.localeCompare(right.name);
}
