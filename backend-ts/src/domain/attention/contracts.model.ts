import { type AttentionID, type AttentionStatus, type DomainActor, type DomainRef, type ScopeOwner } from "../../xuanwu/coreDomainContracts.ts";

export const ATTENTION_TYPES = [
  "blocker",
  "failure",
  "approval_required",
  "input_required",
  "verification_required",
  "connection_issue"
] as const;

export type AttentionType = typeof ATTENTION_TYPES[number];

export const ATTENTION_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

export type AttentionPriority = typeof ATTENTION_PRIORITIES[number];

export const ATTENTION_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type AttentionSeverity = typeof ATTENTION_SEVERITIES[number];

export const ATTENTION_SOURCE_AUTHORITIES = [
  "attention_inbox_items",
  "pi_guardian_alerts",
  "pi_approval_requests",
  "pi_actions",
  "issues"
] as const;

export type AttentionSourceAuthority = typeof ATTENTION_SOURCE_AUTHORITIES[number];

export const ATTENTION_SOURCE_RESOLUTIONS = ["active", "resolved", "dismissed"] as const;

export type AttentionSourceResolution = typeof ATTENTION_SOURCE_RESOLUTIONS[number];

export const ATTENTION_PRIORITY_TABLE = {
  blocker: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
  failure: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
  approval_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  input_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  verification_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  connection_issue: { critical: "p0", high: "p1", medium: "p1", low: "p2" }
} as const satisfies Record<AttentionType, Record<AttentionSeverity, AttentionPriority>>;

export type AttentionSourceRef = {
  authority: AttentionSourceAuthority;
  correlation_refs: string[];
  local_id: string;
  resolution: AttentionSourceResolution;
  source_state: string;
};

export type AttentionCandidate = {
  created_at: string;
  evidence_refs?: string[];
  next_action: string;
  owner: ScopeOwner;
  reason_code: string;
  related_refs?: string[];
  required_actor: string;
  severity: AttentionSeverity;
  source_ref: AttentionSourceRef;
  status: AttentionStatus;
  subject_refs?: DomainRef[];
  summary: string;
  type: AttentionType;
  updated_at: string;
};

export type AttentionEscalation = {
  count: number;
  last_escalated_at?: string;
};

export type AttentionRecord = {
  created_at: string;
  dedupe_key: string;
  evidence_refs: string[];
  escalation: AttentionEscalation;
  id: AttentionID;
  next_action: string;
  owner: ScopeOwner;
  priority: AttentionPriority;
  reason_code: string;
  related_refs: string[];
  required_actor: string;
  revision: number;
  severity: AttentionSeverity;
  snoozed_until?: string;
  source_refs: AttentionSourceRef[];
  status: AttentionStatus;
  subject_refs: DomainRef[];
  summary: string;
  type: AttentionType;
  updated_at: string;
};

export type AttentionTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type AttentionTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: AttentionTransitionGate;
  occurred_at: string;
  reason: string;
};

export type AttentionCommand = {
  action: "acknowledge" | "snooze" | "resolve" | "dismiss" | "escalate";
  audit: AttentionTransitionAudit;
  expected_revision: number;
  snoozed_until?: string;
};

export type AttentionTransitionResult = {
  attention: AttentionRecord;
  audit_event: {
    actor: DomainActor;
    after_status: AttentionStatus;
    before_status: AttentionStatus;
    correlation_id: string;
    event_id: string;
    gate: AttentionTransitionGate;
    occurred_at: string;
    operation: AttentionCommand["action"] | "source_reconciled";
    reason: string;
    source_refs: string[];
  };
};

export const PRIORITY_INDEX: Readonly<Record<AttentionPriority, number>> = { p0: 0, p1: 1, p2: 2, p3: 3 };

export const TERMINAL_ATTENTION_STATUSES = new Set<AttentionStatus>(["resolved", "dismissed"]);

export const TERMINAL_SOURCE_RESOLUTIONS = new Set<AttentionSourceResolution>(["resolved", "dismissed"]);

export const CORRELATION_STRENGTH = [
  "approval:", "run:", "run_group:", "connection:", "issue:", "work:", "conversation:"
] as const;
