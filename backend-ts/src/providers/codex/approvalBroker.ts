import { redactSensitiveText } from "../../util/redact.ts";
import { evaluateApprovalFastPolicy, type ApprovalFastDecision } from "../../pi/approvalFastPolicy.ts";
import { constrainApprovalGrantScope, type ScopedApprovalDecision } from "../../pi/approvalGrantScope.ts";
import { parseCodexApprovalRequest } from "../../pi/approvalRequestParser.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ApprovalDecision, ProviderEvent } from "../types.ts";

type PendingApproval = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type ApprovalBrokerOptions = {
  onEvent?: (event: ProviderEvent) => void;
};

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);

export class CodexApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: ApprovalBrokerOptions = {}) {}

  canHandle(method: string): boolean {
    return APPROVAL_METHODS.has(method.trim());
  }

  async request(jsonRpcId: string | number, method: string, params: unknown): Promise<unknown> {
    if (!this.canHandle(method)) throw new Error(`unsupported approval method: ${method.trim()}`);
    const startedAt = performance.now();
    const request = approvalRequest(jsonRpcId, method, params);
    const fastDecision = evaluateApprovalFastPolicy({ method: request.method, params: request.params });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (fastDecision.decision === "deny-now" || fastDecision.decision === "approve-now") {
      const response = approvalResponse(request.method, request.params, fastDecision.resolver_decision);
      this.publishDeferred(approvalFastResolvedEvent(request, fastDecision, latencyMs));
      return response;
    }
    if (this.pending.has(request.id)) throw new Error(`approval request already pending: ${request.id}`);
    return await new Promise((resolve, reject) => {
      this.pending.set(request.id, { ...request, resolve, reject });
      try {
        this.publish("approval/requested", request, "pending");
      } catch (error) {
        this.pending.delete(request.id);
        reject(asError(error));
      }
    });
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const id = requestId.trim();
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`approval request is not pending: ${id}`);
    this.pending.delete(id);
    const parsed = parseCodexApprovalRequest({ method: pending.method, params: pending.params });
    const scoped = constrainApprovalGrantScope(decision, {
      provider: "codex",
      requestType: parsed.request_type,
      sessionId: parsed.thread_id
    });
    pending.resolve(approvalResponse(pending.method, pending.params, scoped.decision));
    this.publish("approval/resolved", approvalResolvedPayload(id, pending, parsed, scoped), scoped.decision.decision);
  }

  rejectAll(error: Error): void {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private publish(method: string, payload: Record<string, unknown>, status: string): void {
    this.options.onEvent?.(approvalEvent(method, payload, status));
  }

  private publishDeferred(event: ProviderEvent | undefined): void {
    if (!event) return;
    setTimeout(() => {
      try {
        this.options.onEvent?.(event);
      } catch {
        // Fast-path audit hooks are best-effort and must not affect the resolver.
      }
    }, 0);
  }
}

export function codexProviderApprovalDecision(decision: ApprovalDecision): ApprovalDecision {
  return constrainApprovalGrantScope(decision, { provider: "codex" }).decision;
}

function approvalRequest(jsonRpcId: string | number, method: string, params: unknown): PendingApproval {
  const raw = normalizeApprovalParams(recordValue(params));
  const id = approvalRequestId(jsonRpcId, raw);
  return { id, method, params: raw, resolve: () => {}, reject: () => {} };
}

function normalizeApprovalParams(raw: Record<string, unknown>): Record<string, unknown> {
  const threadId = stringField(raw, "threadId") || stringField(raw, "conversationId");
  return threadId && raw.threadId !== threadId ? { ...raw, threadId } : raw;
}

function approvalRequestId(jsonRpcId: string | number, params: Record<string, unknown>): string {
  return firstNonEmpty(
    stringField(params, "approvalId"),
    stringField(params, "itemId"),
    stringField(params, "callId"),
    String(jsonRpcId)
  );
}

function approvalResponse(
  method: string,
  params: Record<string, unknown>,
  decision: ApprovalDecision
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") return permissionsResponse(params, decision);
  if (method === "item/commandExecution/requestApproval") return { decision: commandDecision(decision) };
  if (method === "item/fileChange/requestApproval") return { decision: fileChangeDecision(decision) };
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: legacyDecision(decision) };
  }
  throw new Error(`unsupported approval method: ${method}`);
}

function approvalFastResolvedEvent(
  request: PendingApproval,
  decision: Exclude<ApprovalFastDecision, { decision: "ask-user" }>,
  latencyMs: number
): ProviderEvent {
  const parsed = parseCodexApprovalRequest({ method: request.method, params: request.params });
  return approvalEvent("approval/fast_resolved", {
    id: request.id,
    method: request.method,
    params: approvalAuditParams(request.params),
    decision: decision.resolver_decision.decision,
    scope: decision.resolver_decision.scope ?? "",
    fast_decision: decision.decision,
    latency_ms: latencyMs,
    reason: decision.reason,
    request_summary: parsed.summary,
    request_type: parsed.request_type,
    rule_id: decision.rule_id,
    session_grant_expires_at: decision.session_grant.expires_at,
    session_grant_reason: decision.session_grant.reason,
    session_grant_reusable: decision.session_grant.reusable,
    session_grant_ttl_ms: decision.session_grant.ttl_ms
  }, decision.resolver_decision.decision);
}

function approvalResolvedPayload(
  id: string,
  pending: PendingApproval,
  parsed: ReturnType<typeof parseCodexApprovalRequest>,
  scoped: ScopedApprovalDecision
): Record<string, unknown> {
  return {
    id,
    method: pending.method,
    params: approvalAuditParams(pending.params),
    decision: scoped.decision.decision,
    scope: scoped.decision.scope ?? "turn",
    request_summary: parsed.summary,
    ...scoped.audit
  };
}

function approvalAuditParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: stringField(params, "threadId"),
    turnId: stringField(params, "turnId")
  };
}

function permissionsResponse(params: Record<string, unknown>, decision: ApprovalDecision): Record<string, unknown> {
  return {
    permissions: isApproved(decision) ? recordValue(params.permissions) : {},
    scope: approvalScope(decision)
  };
}

function commandDecision(decision: ApprovalDecision): string {
  if (isCancel(decision)) return "cancel";
  if (!isApproved(decision)) return "decline";
  return approvalScope(decision) === "session" ? "acceptForSession" : "accept";
}

function fileChangeDecision(decision: ApprovalDecision): string {
  return commandDecision(decision);
}

function legacyDecision(decision: ApprovalDecision): string {
  if (isCancel(decision)) return "abort";
  if (!isApproved(decision)) return "denied";
  return approvalScope(decision) === "session" ? "approved_for_session" : "approved";
}

function isCancel(decision: ApprovalDecision): boolean {
  return ["cancel", "abort"].includes(decision.decision.trim());
}

function isApproved(decision: ApprovalDecision): boolean {
  return ["approve", "approved", "accept", "approve_session", "approved_for_session", "acceptForSession"]
    .includes(decision.decision.trim());
}

function approvalScope(decision: ApprovalDecision): "session" | "turn" {
  if (decision.scope?.trim() === "session") return "session";
  return ["approve_session", "approved_for_session", "acceptForSession"].includes(decision.decision.trim())
    ? "session"
    : "turn";
}

function approvalEvent(method: string, payload: Record<string, unknown>, status: string): ProviderEvent {
  const safePayload = redactedPayload(payload) as Record<string, unknown>;
  const params = recordValue(safePayload.params);
  const session = sessionRef(params);
  const resolved = method === "approval/resolved" || method === "approval/fast_resolved";
  return {
    provider: "codex",
    type: "approval",
    status,
    session,
    raw: { method, payload: stableJSON(safePayload) },
    payload: safePayload,
    runEvent: normalizedRunEvent({
      kind: resolved ? "approval_resolved" : "approval_requested",
      method,
      outcome: resolved ? "running" : "waiting_approval",
      provider: "codex",
      session
    })
  };
}

function redactedPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactedPayload);
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) return value;
  return Object.fromEntries(
    Object.entries(raw).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : redactedPayload(item)])
  );
}

function sensitiveKey(key: string): boolean {
  return /(?:token|secret|password|api[_-]?key|access[_-]?key)/i.test(key);
}

function sessionRef(params: Record<string, unknown>): ProviderEvent["session"] {
  const sessionId = stringField(params, "threadId");
  const turnId = stringField(params, "turnId");
  if (sessionId === "" && turnId === "") return undefined;
  return { provider: "codex", sessionId, ...(turnId === "" ? {} : { turnId }) };
}

function stableJSON(value: unknown): string {
  return JSON.stringify(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value !== "") ?? "";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
