import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { createPiProjectTools } from "../http/piProjectTools.ts";
import { callBrowserTool } from "./browserToolCall.ts";
import { callCliConnectorTool } from "./cliConnectorToolCall.ts";
import { callHttpTool } from "./httpToolCall.ts";
import { callMcpTool } from "./mcpToolCall.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "./toolCallAudit.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";
import type { AssistantTool, ToolProvider, ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";

export type ReadOnlyToolInvocationInput = {
  auditContext?: Partial<ToolCallAuditContext>;
  db: RunnerDatabase;
  env?: Record<string, string | undefined>;
  input?: Record<string, unknown>;
  invocationID?: string;
  manifestDirs?: string[];
  projectID?: string;
  providerID: string;
  timeoutMs?: number;
  toolName: string;
};

export class ToolInvocationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInvocationNotFoundError";
  }
}

type InvocationTarget = { provider?: ToolProvider; tool: AssistantTool };
type InvocationClock = { invocationID: string; started: number; startedAt: Date };

export async function invokeReadOnlyAssistantTool(input: ReadOnlyToolInvocationInput): Promise<ToolResult> {
  const clock = invocationClock(input.invocationID);
  const target = findInvocationTarget(input);
  if (!target) throw new ToolInvocationNotFoundError(`tool 不存在: ${input.providerID}:${input.toolName}`);
  if (target.tool.permission !== "read") return auditLocalResult(input, target.tool, deniedResult(clock, target.tool));
  const kind = target.provider?.kind ?? providerKindFromMetadata(target.tool);
  if (kind === "cli") return callCli(input, clock);
  if (kind === "mcp") return callMcp(input, target.tool, clock);
  if (kind === "http") return callHttp(input, target.tool, clock);
  if (kind === "browser") return callBrowser(input, target.tool, clock);
  if (kind === "builtin") return callBuiltin(input, target.tool, clock);
  return auditLocalResult(input, target.tool, unsupportedProviderResult(clock, kind));
}

function findInvocationTarget(input: ReadOnlyToolInvocationInput): InvocationTarget | undefined {
  const snapshot = loadAssistantToolRegistrySnapshot(input.db, {
    cliConnectorDirs: input.manifestDirs ?? [],
    env: input.env
  });
  const tool = snapshot.tools.find((item) =>
    item.provider_id === input.providerID && item.name === input.toolName);
  if (!tool) return undefined;
  return { provider: snapshot.providers.find((item) => item.id === tool.provider_id), tool };
}

async function callCli(input: ReadOnlyToolInvocationInput, clock: InvocationClock): Promise<ToolResult> {
  return await callCliConnectorTool({
    auditContext: auditContext(input),
    db: input.db,
    env: input.env,
    input: input.input ?? {},
    invocationID: clock.invocationID,
    manifestDirs: input.manifestDirs ?? [],
    maxPermission: "read",
    providerID: input.providerID,
    toolName: input.toolName
  });
}

function callMcp(input: ReadOnlyToolInvocationInput, tool: AssistantTool, clock: InvocationClock): ToolResult {
  const capabilityID = mcpCapabilityID(tool);
  if (capabilityID === "") return auditLocalResult(input, tool, failedResult(clock, {
    code: "mcp_capability_missing",
    message: "MCP tool metadata missing capability_id"
  }));
  return callMcpTool({
    auditContext: auditContext(input),
    auditProviderID: tool.provider_id,
    auditToolName: tool.name,
    capabilityID,
    db: input.db,
    input: input.input ?? {},
    invocationID: clock.invocationID,
    maxPermission: "read",
    registry: { registryJson: input.env?.CODEX_RUNNER_MCP_REGISTRY_JSON },
    timeoutMs: input.timeoutMs ?? tool.timeout_ms
  });
}

async function callHttp(input: ReadOnlyToolInvocationInput, tool: AssistantTool, clock: InvocationClock): Promise<ToolResult> {
  return auditLocalResult(input, tool, await callHttpTool({
    input: input.input ?? {},
    invocationID: clock.invocationID,
    timeoutMs: input.timeoutMs ?? tool.timeout_ms,
    toolName: input.toolName
  }));
}

async function callBrowser(input: ReadOnlyToolInvocationInput, tool: AssistantTool, clock: InvocationClock): Promise<ToolResult> {
  return auditLocalResult(input, tool, await callBrowserTool({
    env: input.env,
    input: input.input ?? {},
    invocationID: clock.invocationID,
    toolName: input.toolName
  }));
}

async function callBuiltin(
  input: ReadOnlyToolInvocationInput,
  tool: AssistantTool,
  clock: InvocationClock
): Promise<ToolResult> {
  const definition = builtinDefinition(input, tool.name);
  if (!definition) {
    return auditLocalResult(input, tool, failedResult(clock, {
      code: "builtin_tool_unavailable",
      message: `Builtin tool is not executable through read-only invocation: ${tool.name}`
    }));
  }
  try {
    return auditLocalResult(input, tool, resultFromBuiltin(clock, await executeDefinition(definition, input, clock)));
  } catch (error) {
    return auditLocalResult(input, tool, failedResult(clock, { code: "builtin_tool_error", message: errorMessage(error) }));
  }
}

function builtinDefinition(input: ReadOnlyToolInvocationInput, name: string): ToolDefinition | undefined {
  const context = auditContext(input);
  const projectID = input.projectID || cleanString(input.input?.project_id) || context.projectID;
  const project = projectID ? getProject(input.db, projectID) ?? undefined : undefined;
  const toolContext = {
    conversationID: context.conversationID,
    delegationID: context.delegationID,
    heartbeatID: context.heartbeatID,
    issueID: context.issueID,
    source: context.source || "read_only_tool_invocation"
  };
  return createPiProjectTools(input.db, project, toolContext).find((item) => item.name === name);
}

async function executeDefinition(
  definition: ToolDefinition,
  input: ReadOnlyToolInvocationInput,
  clock: InvocationClock
): Promise<unknown> {
  const result = await definition.execute(
    clock.invocationID,
    input.input ?? {},
    undefined,
    undefined,
    {} as never
  );
  return recordValue(result).details ?? result;
}

function resultFromBuiltin(clock: InvocationClock, output: unknown): ToolResult {
  const status = builtinStatus(output);
  const error = status === "succeeded" ? undefined : builtinError(output, status);
  return finishResult(clock, status, error, status === "succeeded" ? output : undefined, { builtin: true });
}

function auditLocalResult(input: ReadOnlyToolInvocationInput, tool: AssistantTool, result: ToolResult): ToolResult {
  recordToolCallAuditEvent(input.db, auditContext(input), {
    args: input.input ?? {},
    durationMs: result.duration_ms ?? 0,
    error: result.error ? { message: result.error.message, type: result.error.code ?? "tool_error" } : undefined,
    output: result.output,
    providerID: tool.provider_id,
    status: result.status,
    toolCallID: result.invocation_id,
    toolName: tool.name
  });
  return result;
}

function deniedResult(clock: InvocationClock, tool: AssistantTool): ToolResult {
  return finishResult(clock, "denied", {
    code: "permission_denied",
    message: `Read-only invocation cannot execute ${tool.permission} tool ${tool.provider_id}:${tool.name}`
  });
}

function unsupportedProviderResult(clock: InvocationClock, kind: string): ToolResult {
  return failedResult(clock, {
    code: "unsupported_provider",
    message: `Read-only invocation does not support provider kind: ${kind || "unknown"}`
  });
}

function failedResult(clock: InvocationClock, error: ToolResultError): ToolResult {
  return finishResult(clock, "failed", error);
}

function finishResult(
  clock: InvocationClock,
  status: ToolResult["status"],
  error?: ToolResultError,
  output?: unknown,
  metadata?: Record<string, unknown>
): ToolResult {
  const endedAt = new Date();
  return {
    duration_ms: Math.max(0, Math.round(performance.now() - clock.started)),
    ended_at: endedAt.toISOString(),
    invocation_id: clock.invocationID,
    started_at: clock.startedAt.toISOString(),
    status,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function builtinStatus(output: unknown): ToolResult["status"] {
  const status = cleanString(recordValue(output).status);
  if (status === "denied") return "denied";
  if (status === "failed") return "failed";
  if (status === "timeout") return "timeout";
  if (status === "pending" || status === "snoozed") return "denied";
  return "succeeded";
}

function builtinError(output: unknown, status: ToolResult["status"]): ToolResultError {
  const raw = recordValue(output);
  const error = recordValue(raw.error);
  return {
    code: cleanString(error.code) || (status === "denied" ? "permission_denied" : "builtin_tool_error"),
    message: cleanString(error.message) || cleanString(raw.reason) || `Builtin tool ${status}`
  };
}

function auditContext(input: ReadOnlyToolInvocationInput): ToolCallAuditContext {
  const context = input.auditContext ?? {};
  return {
    conversationID: cleanString(context.conversationID),
    delegationID: cleanString(context.delegationID),
    heartbeatID: cleanString(context.heartbeatID),
    issueID: context.issueID,
    projectID: cleanString(context.projectID ?? input.projectID),
    source: cleanString(context.source) || "read_only_tool_invocation"
  };
}

function invocationClock(invocationID: string | undefined): InvocationClock {
  return { invocationID: invocationID || crypto.randomUUID(), started: performance.now(), startedAt: new Date() };
}

function mcpCapabilityID(tool: AssistantTool): string {
  const metadata = recordValue(tool.metadata);
  return cleanString(metadata.capability_id ?? metadata.capabilityID);
}

function providerKindFromMetadata(tool: AssistantTool): ToolProvider["kind"] | "" {
  const kind = cleanString(recordValue(tool.metadata).connector);
  if (kind === "builtin" || kind === "cli" || kind === "mcp" || kind === "http" || kind === "browser") return kind;
  return "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Builtin tool execution failed";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
