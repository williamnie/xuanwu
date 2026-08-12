import { getPiApprovalRequest, upsertPiApprovalRequest } from "../db/repositories/pi/approvalRequests.ts";
import { resolvePiApprovalRequestRecord } from "../db/repositories/pi/approvalLifecycle.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ProviderEvent } from "../providers/types.ts";
import { recordApprovalFastAudit } from "../pi/approvalFastAudit.ts";

export type ApprovalRuntimeContext = {
  database?: RunnerDatabase;
  issueId: number;
  projectId: string;
};

type ParsedApprovalPayload = {
  command: string;
  id: string;
  method: string;
  path: string;
  rawPayload: Record<string, unknown>;
  requestType: string;
  threadID: string;
  turnID: string;
};

export function syncProviderApprovalRequest(
  input: ApprovalRuntimeContext,
  event: ProviderEvent,
  activeRunID: string
): void {
  if (!event.provider || !["codex", "qoder"].includes(String(event.provider))) return;
  const method = event.raw?.method?.trim() ?? "";
  if (method === "approval/requested") {
    recordApprovalRequested(input, event, activeRunID);
  } else if (method === "approval/resolved") {
    recordApprovalResolved(input, event);
  } else if (method === "approval/fast_resolved") {
    recordFastApprovalAudit(input, event, activeRunID);
  }
}

function recordFastApprovalAudit(input: ApprovalRuntimeContext, event: ProviderEvent, activeRunID: string): void {
  try {
    recordApprovalFastAudit(input, event, activeRunID);
  } catch {
    // Fast resolver audit is best-effort and must not affect provider decisions or runtime flow.
  }
}

function recordApprovalRequested(input: ApprovalRuntimeContext, event: ProviderEvent, activeRunID: string): void {
  if (!input.database) return;
  const parsed = parseApprovalPayload(event);
  const approvalID = parsed.id || parsed.threadID || parsed.turnID;
  if (approvalID === "") return;
  upsertPiApprovalRequest(input.database, {
    approval_id: approvalID,
    approval_source: `${event.provider}_provider_event`,
    issue_id: input.issueId,
    project_id: input.projectId,
    provider: event.provider,
    provider_approval_id: parsed.id || approvalID,
    raw_payload_json: parsed.rawPayload,
    request_summary: approvalSummary(parsed),
    request_type: parsed.requestType,
    risk: parsed.requestType === "permission" ? "high" : "medium",
    run_id: activeRunID,
    status: "pending",
    session_id: parsed.threadID,
    thread_id: parsed.threadID,
    turn_id: parsed.turnID
  });
}

function recordApprovalResolved(input: ApprovalRuntimeContext, event: ProviderEvent): void {
  if (!input.database) return;
  const payload = approvalPayload(event);
  const approvalID = cleanString(payload.id ?? payload.approval_id ?? payload.request_id);
  if (approvalID === "" || !getPiApprovalRequest(input.database, approvalID)) return;
  const decision = cleanString(payload.decision) || cleanString(event.status);
  resolvePiApprovalRequestRecord(input.database, approvalID, {
    decision,
    scope: cleanString(payload.scope),
    status: cancelledDecision(decision) ? "cancelled" : undefined
  });
}

function parseApprovalPayload(event: ProviderEvent): ParsedApprovalPayload {
  const rawPayload = approvalPayload(event);
  const params = recordValue(rawPayload.params);
  const item = recordValue(params.item);
  const method = cleanString(rawPayload.method) || cleanString(event.raw?.method);
  const command = cleanString(params.command ?? item.command);
  const path = cleanString(params.path ?? item.path);
  return {
    command,
    id: cleanString(rawPayload.id ?? params.approvalId ?? params.itemId ?? params.callId),
    method,
    path,
    rawPayload,
    requestType: approvalRequestType(method, params, command, path),
    threadID: cleanString(event.session?.sessionId) || cleanString(params.threadId ?? params.conversationId),
    turnID: cleanString(event.session?.turnId) || cleanString(params.turnId)
  };
}

function approvalPayload(event: ProviderEvent): Record<string, unknown> {
  const payload = recordValue(event.payload);
  if (Object.keys(payload).length > 0) return payload;
  if (typeof event.payload === "string") return parseRecord(event.payload);
  const rawPayload = recordValue(event.raw?.payload);
  if (Object.keys(rawPayload).length > 0) return rawPayload;
  if (typeof event.raw?.payload === "string") return parseRecord(event.raw.payload);
  return {};
}

function parseRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function approvalRequestType(
  method: string,
  params: Record<string, unknown>,
  command: string,
  path: string
): string {
  if (method.includes("commandExecution") || command !== "") return "command";
  if (method.includes("fileChange") || path !== "") return "file";
  if (method.includes("permissions") || Object.keys(recordValue(params.permissions)).length > 0) return "permission";
  return "approval";
}

function approvalSummary(parsed: ParsedApprovalPayload): string {
  return [
    parsed.requestType,
    parsed.command ? `command=${parsed.command}` : "",
    parsed.path ? `path=${parsed.path}` : ""
  ].filter(Boolean).join(" ");
}

function cancelledDecision(decision: string): boolean {
  return ["abort", "aborted", "cancel", "cancelled"].includes(decision.trim());
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
