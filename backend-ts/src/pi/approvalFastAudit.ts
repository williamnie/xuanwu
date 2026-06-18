import { createHash } from "node:crypto";
import { upsertPiApprovalRequest } from "../db/repositories/pi/approvalRequests.ts";
import { upsertPiGuardianDecision } from "../db/repositories/pi/guardianDecisions.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ProviderEvent } from "../providers/types.ts";
import { parseCodexApprovalRequest } from "./approvalRequestParser.ts";

export type ApprovalFastAuditContext = {
  database?: RunnerDatabase;
  issueId: number;
  projectId: string;
};

type FastAuditPayload = {
  decision: string;
  fastDecision: string;
  id: string;
  latencyMs: number;
  method: string;
  params: Record<string, unknown>;
  payload: Record<string, unknown>;
  reason: string;
  requestSummary: string;
  requestType: string;
  ruleID: string;
  scope: string;
  sessionGrantExpiresAt: string;
  sessionGrantReason: string;
  sessionGrantReusable: boolean;
  sessionGrantTtlMs: number;
};

export function recordApprovalFastAudit(
  input: ApprovalFastAuditContext,
  event: ProviderEvent,
  activeRunID: string
): void {
  if (!input.database || event.provider !== "codex") return;
  const record = buildFastAuditRecord(input, event, activeRunID);
  if (!record) return;
  upsertPiApprovalRequest(input.database, record.approvalRequest);
  upsertPiGuardianDecision(input.database, record.guardianDecision);
}

type FastAuditRecord = {
  approvalRequest: Parameters<typeof upsertPiApprovalRequest>[1];
  guardianDecision: Parameters<typeof upsertPiGuardianDecision>[1];
};

function buildFastAuditRecord(
  input: ApprovalFastAuditContext,
  event: ProviderEvent,
  activeRunID: string
): FastAuditRecord | null {
  const audit = fastAuditPayload(event);
  const approvalID = audit.id || event.session?.sessionId || event.session?.turnId || "";
  if (approvalID === "") return null;
  const parsed = parseCodexApprovalRequest({
    method: audit.method,
    params: audit.params
  });
  const requestSummary = audit.requestSummary || parsed.summary;
  const requestType = audit.requestType || parsed.request_type;
  const decision = normalizedDecision(audit.decision, event.status);
  const status = statusForDecision(decision);
  return {
    approvalRequest: approvalRequestAuditInput({
      activeRunID, approvalID, audit, decision, event, input, requestSummary, requestType, status
    }),
    guardianDecision: guardianDecisionAuditInput({
      approvalID, audit, decision, input, requestSummary, status
    })
  };
}

function approvalRequestAuditInput(args: {
  activeRunID: string; approvalID: string; audit: FastAuditPayload; decision: string;
  event: ProviderEvent; input: ApprovalFastAuditContext; requestSummary: string;
  requestType: string; status: string;
}): FastAuditRecord["approvalRequest"] {
  return {
    approval_id: args.approvalID,
    approval_source: "codex_provider_fast_resolver",
    async_escalation_state: "none",
    decision: args.decision,
    fast_decision: fastDecision(args.audit.fastDecision, args.decision),
    fast_decision_reason: args.audit.reason,
    fast_policy_latency_ms: args.audit.latencyMs,
    fast_policy_rule: args.audit.ruleID,
    issue_id: args.input.issueId,
    project_id: args.input.projectId,
    provider: args.event.provider,
    provider_approval_id: args.approvalID,
    raw_payload_json: auditSummaryRef(args.audit, args.requestSummary),
    request_summary: args.requestSummary,
    request_type: args.requestType,
    resolved_decision: args.decision,
    resolved_scope: cleanScope(args.audit.scope),
    risk: riskForDecision(args.decision),
    run_id: args.activeRunID,
    session_id: args.event.session?.sessionId,
    status: args.status,
    thread_id: args.event.session?.sessionId,
    turn_id: args.event.session?.turnId
  };
}

function guardianDecisionAuditInput(args: {
  approvalID: string; audit: FastAuditPayload; decision: string;
  input: ApprovalFastAuditContext; requestSummary: string; status: string;
}): FastAuditRecord["guardianDecision"] {
  return {
    authority: "policy",
    decision: guardianDecision(args.decision),
    decision_kind: "approval",
    evidence_json: [decisionEvidence(args.approvalID, args.audit, args.requestSummary)],
    id: `approval-fast:${args.approvalID}`,
    idempotency_key: `approval:${args.input.projectId}:${args.input.issueId}:${args.approvalID}`,
    issue_id: args.input.issueId,
    project_id: args.input.projectId,
    rationale: args.audit.reason,
    requires_user: args.status === "rejected" ? 1 : 0,
    risk_level: riskForDecision(args.decision),
    source_event_id: args.approvalID,
    state: "completed"
  };
}

function decisionEvidence(approvalID: string, audit: FastAuditPayload, summary: string): Record<string, string> {
  return {
    approval_id: approvalID,
    payload_hash: payloadHash(audit.payload),
    request_ref: `pi_approval_requests:${approvalID}`,
    summary
  };
}

function fastAuditPayload(event: ProviderEvent): FastAuditPayload {
  const payload = recordValue(event.payload);
  const params = recordValue(payload.params);
  return {
    decision: cleanString(payload.decision),
    fastDecision: cleanString(payload.fast_decision),
    id: cleanString(payload.id),
    latencyMs: nonNegativeInteger(payload.latency_ms),
    method: cleanString(payload.method),
    params,
    payload,
    reason: cleanString(payload.reason),
    requestSummary: cleanString(payload.request_summary),
    requestType: cleanString(payload.request_type),
    ruleID: cleanString(payload.rule_id),
    scope: cleanString(payload.scope),
    sessionGrantExpiresAt: cleanString(payload.session_grant_expires_at),
    sessionGrantReason: cleanString(payload.session_grant_reason),
    sessionGrantReusable: payload.session_grant_reusable === true,
    sessionGrantTtlMs: nonNegativeInteger(payload.session_grant_ttl_ms)
  };
}

function auditSummaryRef(audit: FastAuditPayload, summary: string): Record<string, unknown> {
  return {
    payload_hash: payloadHash(audit.payload),
    reason: audit.reason,
    rule_id: audit.ruleID,
    session_grant_expires_at: audit.sessionGrantExpiresAt,
    session_grant_reason: audit.sessionGrantReason,
    session_grant_reusable: audit.sessionGrantReusable,
    session_grant_ttl_ms: audit.sessionGrantTtlMs,
    summary
  };
}

function payloadHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJSON(value)).digest("hex")}`;
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) return JSON.stringify(value ?? null);
  return `{${Object.keys(raw).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(raw[key])}`).join(",")}}`;
}

function normalizedDecision(decision: string, status: unknown): string {
  const value = decision || cleanString(status);
  if (["approve", "approved", "accept", "approve_session", "approved_for_session", "acceptForSession"].includes(value)) {
    return value === "approve_session" || value === "approved_for_session" || value === "acceptForSession"
      ? "approve_session"
      : "approve";
  }
  if (["cancel", "cancelled", "abort", "aborted"].includes(value)) return "cancel";
  return "deny";
}

function fastDecision(value: string, decision: string): string {
  if (value === "approve-now") return "approve";
  if (value === "deny-now") return "deny";
  return decision === "approve" || decision === "approve_session" ? "approve" : "deny";
}

function guardianDecision(decision: string): string {
  return decision === "approve" || decision === "approve_session" ? "approve" : "deny";
}

function statusForDecision(decision: string): string {
  if (decision === "cancel") return "cancelled";
  return decision === "approve" || decision === "approve_session" ? "approved" : "rejected";
}

function riskForDecision(decision: string): string {
  return decision === "approve" || decision === "approve_session" ? "low" : "medium";
}

function cleanScope(value: string): string {
  return value === "session" ? "session" : "turn";
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
