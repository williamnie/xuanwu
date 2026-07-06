import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiMcpActionLayer } from "./mcpActionTools.ts";

export const PI_MCP_TOOL_NAMES = [
  "mcp_registry_list",
  "mcp_capability_read",
  "mcp_requirement_recommend",
  "mcp_resource_list",
  "mcp_resource_read",
  "mcp_tool_call"
] as const;

type McpToolName = (typeof PI_MCP_TOOL_NAMES)[number];
type McpExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

export function createPiMcpActionTools(actions: PiMcpActionLayer): ToolDefinition[] {
  return [
    mcpTool("mcp_registry_list", "MCP Registry List", "List MCP servers and capabilities visible to PI.",
      Type.Object({}, objectOptions), actions.listMcpRegistry),
    mcpTool("mcp_capability_read", "MCP Capability Read", "Read one MCP capability record by id.",
      Type.Object({ capability_id: requiredText }, objectOptions), actions.readMcpCapability),
    mcpTool("mcp_requirement_recommend", "MCP Requirement Recommend", "Recommend MCP capabilities for an issue prompt.",
      Type.Object({ description: optionalString, project_id: optionalString, title: optionalString }, objectOptions), actions.recommendMcpRequirements),
    mcpTool("mcp_resource_list", "MCP Resource List", "List read-only MCP resources visible to PI.",
      Type.Object({ server_id: optionalString }, objectOptions), actions.listMcpResources),
    mcpTool("mcp_resource_read", "MCP Resource Read", "Read a read-only MCP resource through the action gate.",
      Type.Object({ capability_id: requiredText }, objectOptions), actions.readMcpResource),
    mcpTool("mcp_tool_call", "MCP Tool Call", "Call a registered MCP tool through the shared permission, timeout, and audit envelope.",
      Type.Object({
        capability_id: requiredText,
        input: Type.Optional(Type.Record(Type.String(), Type.Any())),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1 }))
      }, objectOptions), actions.callMcpTool)
  ];
}

function mcpTool<TParams extends TSchema>(
  name: McpToolName,
  label: string,
  description: string,
  parameters: TParams,
  executeMcp: McpExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      const details = executeMcp(params);
      return toolResult(details);
    }
  };
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) ?? "null" }], details };
}
