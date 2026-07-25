import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { redactAuditJsonText, redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { RUNNER_BUILTIN_PROVIDER_ID } from "./builtinToolRegistry.ts";
import type { ToolPermission, ToolResultStatus } from "./toolProviderEnvelope.ts";

export type ToolCallAuditContext = {
  conversationID: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  projectID?: string;
  source?: string;
};

type ToolCallAuditInput = {
  args: unknown;
  durationMs: number;
  error?: { message: string; type: string };
  output?: unknown;
  permission?: ToolPermission;
  providerID?: string;
  status: ToolResultStatus;
  toolCallID: string;
  toolName: string;
};

const SUMMARY_LIMIT = 512;

export function recordToolCallAuditEvent(
  db: RunnerDatabase,
  context: ToolCallAuditContext,
  input: ToolCallAuditInput
): void {
  const payload = toolCallAuditEnvelope(context, input);
  createPiActionEvent(db, {
    action_id: `tool-call:${input.toolCallID || crypto.randomUUID()}`,
    actor: "assistant_tool",
    conversation_id: context.conversationID,
    delegation_id: context.delegationID,
    error: input.error?.message,
    event_type: "tool_call_audit",
    heartbeat_id: context.heartbeatID,
    issue_id: context.issueID ?? 0,
    payload_json: JSON.stringify(payload),
    project_id: context.projectID,
    reason: `${payload.provider_id}:${payload.tool} ${payload.status}`
  });
}

function toolCallAuditEnvelope(context: ToolCallAuditContext, input: ToolCallAuditInput) {
  const providerID = input.providerID || RUNNER_BUILTIN_PROVIDER_ID;
  return {
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    error: input.error ? safeError(input.error) : undefined,
    input_summary: auditSummary(input.args),
    output_summary: input.output === undefined ? undefined : auditSummary(input.output),
    permission: input.permission ?? "unknown",
    provider: providerID,
    provider_id: providerID,
    result: input.status,
    source: cleanString(context.source) || "pi_runtime",
    status: input.status,
    tool: cleanString(input.toolName),
    tool_call_id: cleanString(input.toolCallID)
  };
}

function auditSummary(value: unknown) {
  const text = redactedText(value);
  return {
    preview: truncate(text),
    size_chars: text.length,
    truncated: text.length > SUMMARY_LIMIT,
    type: valueType(value)
  };
}

function redactedText(value: unknown): string {
  if (typeof value === "string") return redactAuditText(value);
  return redactAuditJsonText(safeJson(value));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function safeError(error: { message: string; type: string }) {
  return {
    message: truncate(redactAuditText(error.message)),
    type: cleanString(error.type) || "tool_error"
  };
}

function truncate(value: string): string {
  if (value.length <= SUMMARY_LIMIT) return value;
  return `${value.slice(0, SUMMARY_LIMIT)}…[truncated ${value.length - SUMMARY_LIMIT} chars]`;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
