import { getPiApprovalRequest, resolvePiApprovalRequestRecord } from "../db/repositories/pi.ts";
import type { Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { AppEvent } from "../events/bus.ts";
import type { ApprovalDecision, ExecutorProvider } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { type FeishuApprovalAction } from "./feishuApprovalCards.ts";

export type FeishuApprovalResolveInput = FeishuApprovalAction & {
  provider?: Pick<ExecutorProvider, "resolveApproval">;
};

export type ParsedApproval = {
  command: string;
  id: string;
  method: string;
  path: string;
  requestType: string;
  threadID: string;
  turnID: string;
};

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export async function resolvePiApprovalRequestFromFeishu(
  db: RunnerDatabase,
  input: FeishuApprovalResolveInput
): Promise<{ ok: true; status: string }> {
  const request = getPiApprovalRequest(db, input.requestID);
  if (!request) throw new Error("pi approval request not found");
  if (["approved", "rejected", "cancelled", "expired"].includes(request.status)) return { ok: true, status: request.status };
  const decision = normalizeApprovalDecision(input.decision);
  const scope = cleanScope(input.scope || request.resolved_scope);
  if (decision !== "defer") {
    if (!input.provider?.resolveApproval) throw new Error("codex provider approval resolver is not available");
    await input.provider.resolveApproval(request.provider_approval_id || request.approval_id, {
      decision,
      scope
    } satisfies ApprovalDecision);
  }
  const resolved = resolvePiApprovalRequestRecord(db, request.approval_id, {
    decision,
    scope,
    status: decision === "defer" ? "delivered" : undefined
  });
  return { ok: true, status: resolved.status };
}

export function recordCodexApprovalResolved(db: RunnerDatabase, event: AppEvent): void {
  const raw = parseObject(event.payload);
  const approvalID = safeText(raw.id || raw.approval_id || raw.request_id);
  if (approvalID === "" || !getPiApprovalRequest(db, approvalID)) return;
  resolvePiApprovalRequestRecord(db, approvalID, {
    decision: normalizeApprovalDecision(safeText(raw.decision || event.status)),
    scope: cleanScope(safeText(raw.scope))
  });
}

export function parseCodexApprovalPayload(event: AppEvent): ParsedApproval {
  const raw = parseObject(event.payload);
  const params = parseObject(raw.params);
  const item = parseObject(params.item);
  const method = safeText(raw.method || event.raw_method || event.method);
  return {
    command: safeText(params.command || item.command),
    id: safeText(raw.id || params.approvalId || params.itemId || params.callId),
    method,
    path: safeText(params.path || item.path),
    requestType: approvalRequestType(method, params),
    threadID: safeText(params.threadId || params.conversationId),
    turnID: safeText(params.turnId)
  };
}

export function approvalRecordInput(event: AppEvent, issue: Issue, parsed: ParsedApproval, approvalID: string) {
  return {
    approval_id: approvalID,
    approval_source: "codex_provider_event",
    issue_id: issue.id,
    project_id: issue.project_id,
    provider: safeText(event.provider) || "codex",
    provider_approval_id: approvalID,
    raw_payload_json: parseObject(event.payload),
    request_summary: approvalSummary(parsed),
    request_type: parsed.requestType,
    risk: parsed.requestType === "permission" ? "high" : "medium",
    status: "pending",
    thread_id: safeText(event.threadId) || parsed.threadID,
    turn_id: safeText(event.turnId) || parsed.turnID
  };
}

function approvalRequestType(method: string, params: Record<string, unknown>): string {
  if (method.includes("commandExecution") || safeText(params.command) !== "") return "command";
  if (method.includes("fileChange") || safeText(params.path) !== "") return "file";
  if (method.includes("permissions") || Object.keys(parseObject(params.permissions)).length > 0) return "permission";
  return "approval";
}

function approvalSummary(parsed: ParsedApproval): string {
  return [
    parsed.requestType,
    parsed.command ? `command=${parsed.command}` : "",
    parsed.path ? `path=${parsed.path}` : ""
  ].filter(Boolean).join(" ");
}

function normalizeApprovalDecision(value: string): string {
  const text = value.trim();
  if (["approve_session", "approved_for_session", "acceptForSession"].includes(text)) return "approve_session";
  if (["approve", "approved", "accept", "approve_once"].includes(text)) return "approve";
  if (["defer", "snooze", "later"].includes(text)) return "defer";
  return "deny";
}

function cleanScope(value: string): string {
  return value.trim() === "session" ? "session" : "turn";
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]").trim() : "";
}
