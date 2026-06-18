import type { ApprovalDecision } from "../providers/types.ts";

export type ApprovalGrantScopeAudit = {
  effective_decision: string;
  effective_scope: "turn" | "session";
  provider: string;
  request_type: string;
  requested_decision: string;
  requested_scope: "turn" | "session";
  scope_reason: string;
  scope_rule_id: ApprovalGrantScopeRuleID;
  session_grant_expires_at: string;
  session_grant_reusable: boolean;
  session_grant_ttl_ms: number;
  session_id: string;
};

export type ApprovalGrantScopeContext = {
  provider?: string;
  requestType?: string;
  sessionId?: string;
};

export type ScopedApprovalDecision = {
  audit: ApprovalGrantScopeAudit;
  decision: ApprovalDecision;
};

export type ApprovalGrantScopeRuleID =
  | "pi_approval_scope_turn_default"
  | "pi_approval_session_grant_disabled_provider_semantics_opaque";

export function constrainApprovalGrantScope(
  decision: ApprovalDecision,
  context: ApprovalGrantScopeContext = {}
): ScopedApprovalDecision {
  const requestedScope = approvalScope(decision);
  if (isCancel(decision)) {
    return scopedDecision(decision, {
      decision: decision.decision,
      scope: "turn"
    }, requestedScope, context, "cancel is scoped to the current turn");
  }
  if (!isApproved(decision)) {
    return scopedDecision(decision, { decision: "deny", scope: "turn" }, requestedScope, context, "deny is scoped to the current turn");
  }
  if (requestedScope === "session") {
    return scopedDecision(
      decision,
      { decision: "approve", scope: "turn" },
      requestedScope,
      context,
      "provider acceptForSession semantics are not proven narrow; approving current turn only",
      "pi_approval_session_grant_disabled_provider_semantics_opaque"
    );
  }
  return scopedDecision(decision, { decision: "approve", scope: "turn" }, requestedScope, context, "approval defaults to current turn");
}

function scopedDecision(
  requested: ApprovalDecision,
  effective: ApprovalDecision,
  requestedScope: "turn" | "session",
  context: ApprovalGrantScopeContext,
  reason: string,
  ruleID: ApprovalGrantScopeRuleID = "pi_approval_scope_turn_default"
): ScopedApprovalDecision {
  const effectiveScope = approvalScope(effective);
  return {
    decision: effective,
    audit: {
      effective_decision: effective.decision,
      effective_scope: effectiveScope,
      provider: cleanString(context.provider),
      request_type: cleanString(context.requestType),
      requested_decision: cleanString(requested.decision),
      requested_scope: requestedScope,
      scope_reason: reason,
      scope_rule_id: ruleID,
      session_grant_expires_at: "",
      session_grant_reusable: false,
      session_grant_ttl_ms: 0,
      session_id: cleanString(context.sessionId)
    }
  };
}

function approvalScope(decision: ApprovalDecision): "session" | "turn" {
  if (decision.scope?.trim() === "session") return "session";
  return ["approve_session", "approved_for_session", "acceptForSession"].includes(decision.decision.trim())
    ? "session"
    : "turn";
}

function isCancel(decision: ApprovalDecision): boolean {
  return ["cancel", "abort"].includes(decision.decision.trim());
}

function isApproved(decision: ApprovalDecision): boolean {
  return ["approve", "approved", "accept", "approve_session", "approved_for_session", "acceptForSession"]
    .includes(decision.decision.trim());
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
