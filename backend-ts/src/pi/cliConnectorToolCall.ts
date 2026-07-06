import type { RunnerDatabase } from "../db/database.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "./toolCallAudit.ts";
import { loadCliConnectorRegistry, findCliConnectorToolRef } from "./cliConnectorProvider.ts";
import { runCliTool } from "./cliToolRunner.ts";
import type { ToolPermission, ToolResult } from "./toolProviderEnvelope.ts";

export type CliConnectorToolCallInput = {
  auditContext?: Partial<ToolCallAuditContext>;
  db: RunnerDatabase;
  env?: Record<string, string | undefined>;
  input?: Record<string, unknown>;
  invocationID?: string;
  manifestDirs: string[];
  maxPermission?: ToolPermission;
  providerID: string;
  toolName: string;
};

const PERMISSION_LEVEL: Record<ToolPermission, number> = { read: 0, write: 1, dangerous: 2 };

export async function callCliConnectorTool(request: CliConnectorToolCallInput): Promise<ToolResult> {
  const registry = loadCliConnectorRegistry({ env: request.env, manifestDirs: request.manifestDirs });
  const ref = findCliConnectorToolRef(registry, request.providerID, request.toolName);
  if (!ref) throw new Error(`CLI tool not found: ${request.providerID}:${request.toolName}`);
  const invocationID = request.invocationID || crypto.randomUUID();
  const startedAt = new Date();
  if (!permissionAllows(request.maxPermission ?? "read", ref.tool.permission)) {
    return auditResult(request, deniedResult(invocationID, startedAt, ref.tool.permission), ref.tool.provider_id, ref.tool.name);
  }
  const result = await runCliTool({
    command: ref.command,
    cwd: ref.manifestDir,
    env: request.env,
    envAllowlist: ref.envNames,
    input: request.input ?? {},
    invocationID,
    redactInputFields: redactInputFields(ref.tool.audit.redact),
    secretEnvNames: ref.secretEnvNames,
    timeoutMs: ref.tool.timeout_ms
  });
  return auditResult(request, result, ref.tool.provider_id, ref.tool.name);
}

function auditResult(
  request: CliConnectorToolCallInput,
  result: ToolResult,
  providerID: string,
  toolName: string
): ToolResult {
  recordToolCallAuditEvent(request.db, auditContext(request), {
    args: request.input ?? {},
    durationMs: result.duration_ms ?? 0,
    error: result.error ? { message: result.error.message, type: result.error.code ?? "tool_error" } : undefined,
    output: result.output,
    providerID,
    status: result.status,
    toolCallID: result.invocation_id,
    toolName
  });
  return result;
}

function deniedResult(invocationID: string, startedAt: Date, required: ToolPermission): ToolResult {
  const endedAt = new Date();
  return {
    duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    ended_at: endedAt.toISOString(),
    error: { code: "permission_denied", message: `Permission ${required} is required to call this CLI tool` },
    invocation_id: invocationID,
    started_at: startedAt.toISOString(),
    status: "denied"
  };
}

function auditContext(request: CliConnectorToolCallInput): ToolCallAuditContext {
  const context = request.auditContext ?? {};
  return {
    conversationID: cleanString(context.conversationID),
    delegationID: cleanString(context.delegationID),
    heartbeatID: cleanString(context.heartbeatID),
    issueID: context.issueID,
    projectID: cleanString(context.projectID),
    source: cleanString(context.source) || "cli_connector_tool"
  };
}

function permissionAllows(max: ToolPermission, required: ToolPermission): boolean {
  return PERMISSION_LEVEL[max] >= PERMISSION_LEVEL[required];
}

function redactInputFields(paths: string[]): string[] {
  return paths.flatMap((path) => path.startsWith("input.") ? [path.slice("input.".length)] : []);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
