export type ApprovalScope = "once" | "session" | "project";
export type ApprovalScopeSupport = "active" | "disabled" | "policy_only";
export type ApprovalRiskClass = "read_only" | "internal_write" | "external_write" | "dangerous";

export type ApprovalPermissionRow = {
  action_family: string;
  audit_authority: string;
  current_scope: ApprovalScope | "none";
  gate: "execute" | "ask" | "deny";
  risk_class: ApprovalRiskClass;
  target_scopes: readonly ApprovalScope[];
};

export type ApprovalScopeContract = {
  authority: string;
  current_support: ApprovalScopeSupport;
  current_ttl: string;
  id: ApprovalScope;
  target_ttl: string;
  target_use: string;
};

export const APPROVAL_SCOPE_CONTRACT = [
  {
    authority: "pi_approval_requests decision/resolved_* plus pi_actions idempotency_key and pi_action_events",
    current_support: "active",
    current_ttl: "No reusable grant: the provider resolver receives a current-turn approval only.",
    id: "once",
    target_ttl: "Consumed by the exact action attempt; it expires before dispatch when its bound action, digest, policy revision, or authorization window changes.",
    target_use: "One exact action subject and one idempotency key; replay returns the already-audited outcome and never dispatches again."
  },
  {
    authority: "provider approval protocol; no Runner session-grant row exists",
    current_support: "disabled",
    current_ttl: "0 ms. Codex acceptForSession is deterministically downgraded to the current turn because provider semantics are not proven narrow.",
    id: "session",
    target_ttl: "Explicit bounded TTL, capped by the enclosing policy window and invalidated by session end, revoke, scope change, or policy revision.",
    target_use: "Only an exact provider/session/action-family allowlist; external write and dangerous actions remain once-only."
  },
  {
    authority: "project_pi_policies and project settings; no Runner project approval-grant row exists",
    current_support: "policy_only",
    current_ttl: "The policy authorization window is the only current project-level TTL; it is not a human approval grant.",
    id: "project",
    target_ttl: "Explicit bounded TTL, capped by project policy and invalidated by revoke, policy revision, project pause, or scope expansion.",
    target_use: "A deterministic policy ceiling for named low-risk action families only; never a blanket grant for push, PR, deploy, external write, or dangerous commands."
  }
] as const satisfies readonly ApprovalScopeContract[];

export const APPROVAL_PERMISSION_MATRIX = [
  {
    action_family: "trusted read-only",
    audit_authority: "pi_actions + pi_action_events when invoked by PI",
    current_scope: "none",
    gate: "execute",
    risk_class: "read_only",
    target_scopes: []
  },
  {
    action_family: "scoped internal write (Issue/Work/Run/Evidence/Handoff control)",
    audit_authority: "pi_actions + pi_action_events",
    current_scope: "once",
    gate: "ask",
    risk_class: "internal_write",
    target_scopes: ["once", "session", "project"]
  },
  {
    action_family: "provider command/file approval",
    audit_authority: "pi_approval_requests + resolver audit + provider event",
    current_scope: "once",
    gate: "ask",
    risk_class: "internal_write",
    target_scopes: ["once", "session"]
  },
  {
    action_family: "git push / PR / deploy / external write",
    audit_authority: "pi_actions + pi_action_events + provider/outbox delivery audit",
    current_scope: "once",
    gate: "ask",
    risk_class: "external_write",
    target_scopes: ["once"]
  },
  {
    action_family: "destructive command / force push / privilege or secret access",
    audit_authority: "pi_actions + pi_action_events + deterministic safety-policy decision",
    current_scope: "once",
    gate: "deny",
    risk_class: "dangerous",
    target_scopes: ["once"]
  }
] as const satisfies readonly ApprovalPermissionRow[];

export const APPROVAL_MIGRATION_CONTRACT = {
  audit: "Every request, deterministic gate decision, human decision, provider resolve attempt, dispatch start/result, deny, expiry, and revoke records actor, reason, policy/gate reference, bound subject, correlation/idempotency reference, and timestamp. LLM output is proposal data only.",
  current_authorities: "pi_approval_requests is the provider-approval request and resolution authority. pi_actions plus pi_action_events is the internal Action Gate and execution authority. project_pi_policies is the project policy authority. Provider protocols remain the authority for provider-side acknowledgement.",
  current_window: "G0/W0: no universal Approval table, no universal resume-token bearer, no dual read, and no dual write. Existing carriers keep their writers and are projected into Attention only.",
  gate_order: [
    "Normalize the action/request and bind its project, session, issue/run, action family, idempotency key, payload digest, and policy revision.",
    "Apply deterministic safety deny-list, authorization window/TTL, revoke state, policy allowlist, scope, recovery limits, and risk classification before any provider or external call.",
    "If no active exact grant remains, persist an ask/deny decision and its audit before notifying or resolving a provider approval.",
    "On approval, mint only a non-bearer resumable binding; execute through the existing Action Gate and record dispatch/result.",
    "On retry/restart, consume the same binding through its idempotency key and return the existing terminal/in-flight result; never re-dispatch."
  ],
  resume_token: "Target resume token is an opaque stored hash, never an LLM or client-provided capability. It binds approval request id, action id/type, project/session scope, payload digest, idempotency key, policy revision, expiry, and revocation generation. A mismatched, expired, consumed, or revoked token fails closed and is audited.",
  rollback: "Before G4, disable any additive grant projection and continue the current carrier writers; no approval decision is dual-written. After G4, stop the target writer, replay only audited cutover deltas into the retained compatibility path, and prove there is one writer before resuming.",
  target_schema: "A later additive migration may add a single Approval grant/resume carrier only after this contract has an accepted field/state mapping. It must reference pi_approval_requests and pi_actions rather than copy their lifecycle, and must declare W1/W2 expiry, dual-read, rollback, and consumer-zero delete gates.",
  deletion_gate: "P11/G7 only: no pending request or active grant, one release with zero legacy consumers, request/decision/audit parity, fresh backup, isolated restore rehearsal, retained rollback artifact, and exact non-LLM destructive approval."
} as const;

export function approvalScopeContract(scope: ApprovalScope): ApprovalScopeContract {
  const contract = APPROVAL_SCOPE_CONTRACT.find((item) => item.id === scope);
  if (!contract) throw new Error(`unsupported Approval scope: ${scope}`);
  return contract;
}
