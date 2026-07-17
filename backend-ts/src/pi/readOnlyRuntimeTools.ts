import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { invokeReadOnlyAssistantTool } from "./readOnlyToolInvocation.ts";
import type { AssistantTool, ToolProvider } from "./toolProviderEnvelope.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";

export type RuntimeReadOnlyToolContext = {
  cliConnectorDirs?: string[];
  conversationID?: string;
  delegationID?: string;
  env?: Record<string, string | undefined>;
  heartbeatID?: string;
  issueID?: number;
  source?: string;
};

export type RuntimeReadOnlyToolKit = {
  providerIDs: string[];
  tools: ToolDefinition[];
};

const RUNTIME_READ_ONLY_PROVIDER_KINDS = new Set<ToolProvider["kind"]>(["http"]);
const TOOL_RESULT_MAX_CHARS = 8192;

export function createReadOnlyRuntimeTools(input: {
  context: RuntimeReadOnlyToolContext;
  db: RunnerDatabase;
  existingNames: Set<string>;
  projectID?: string;
  providers: ToolProvider[];
  tools: AssistantTool[];
}): RuntimeReadOnlyToolKit {
  const providerByID = new Map(input.providers.map((provider) => [provider.id, provider]));
  const selected = input.tools.filter((tool) =>
    shouldExposeReadOnlyRuntimeTool(tool, providerByID.get(tool.provider_id), input.existingNames));
  return {
    providerIDs: sortedUnique(selected.map((tool) => tool.provider_id)),
    tools: selected.map((tool) => runtimeToolDefinition(input, tool))
  };
}

function shouldExposeReadOnlyRuntimeTool(
  tool: AssistantTool,
  provider: ToolProvider | undefined,
  existingNames: Set<string>
): boolean {
  if (!provider || provider.status === "disabled") return false;
  if (!RUNTIME_READ_ONLY_PROVIDER_KINDS.has(provider.kind)) return false;
  if (tool.permission !== "read" || existingNames.has(tool.name)) return false;
  return cleanString(tool.name) !== "" && cleanString(tool.provider_id) !== "";
}

function runtimeToolDefinition(
  input: {
    context: RuntimeReadOnlyToolContext;
    db: RunnerDatabase;
    projectID?: string;
    providers: ToolProvider[];
  },
  tool: AssistantTool
): ToolDefinition {
  const provider = input.providers.find((item) => item.id === tool.provider_id);
  return {
    name: tool.name,
    label: cleanString(provider?.name) || tool.name,
    description: tool.description,
    parameters: unsafeParameters(tool.input_schema),
    promptSnippet: `${tool.name}: ${tool.description}`,
    promptGuidelines: [`Use ${tool.name} for bounded read-only source evidence before answering about URLs or web pages.`],
    async execute(toolCallID, params) {
      const result = await invokeReadOnlyAssistantTool({
        auditContext: auditContext(input.context, input.projectID),
        db: input.db,
        env: input.context.env,
        input: recordValue(params),
        invocationID: toolCallID,
        manifestDirs: input.context.cliConnectorDirs,
        projectID: input.projectID,
        providerID: tool.provider_id,
        timeoutMs: tool.timeout_ms,
        toolName: tool.name
      });
      return toolResult(result);
    }
  };
}

function auditContext(context: RuntimeReadOnlyToolContext, projectID: string | undefined) {
  return {
    conversationID: cleanString(context.conversationID),
    delegationID: cleanString(context.delegationID),
    heartbeatID: cleanString(context.heartbeatID),
    issueID: context.issueID,
    projectID,
    source: cleanString(context.source) || "pi_runtime"
  };
}

function unsafeParameters(schema: Record<string, unknown>): TSchema {
  return Type.Unsafe<Record<string, unknown>>(schema);
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: boundedToolResultText(details) }],
    details
  };
}

function boundedToolResultText(details: unknown): string {
  return formatModelVisibleToolOutput(details, { maxChars: TOOL_RESULT_MAX_CHARS, source: "web" });
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
