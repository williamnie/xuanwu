export const EVENT_RETENTION_SCHEMA_VERSION = "xuanwu.event-retention-policy.v1" as const;

export const EVENT_RETENTION_POLICY_VERSION = "2026-08-03" as const;

export const SUMMARY_WATERMARK_SCHEMA_VERSION = "xuanwu.summary-watermark.v1" as const;

export const ARCHIVE_RECEIPT_SCHEMA_VERSION = "xuanwu.event-archive-receipt.v1" as const;

export const EVENT_RETENTION_POLICY_IDS = [
  "raw_operational",
  "raw_durable",
  "state_event",
  "audit_event",
  "delivery_evidence",
  "review_required"
] as const;

export type EventRetentionPolicyID = typeof EVENT_RETENTION_POLICY_IDS[number];

export type EventRetentionTier = "R0_DERIVED" | "R1_OPERATIONAL" | "R2_DURABLE" | "R3_AUDIT" | "REVIEW_REQUIRED";

type EventRetentionClass = "raw_log" | "state_event" | "audit_event" | "delivery_evidence" | "review_required";

type EventRetentionSource =
  | "issue_events"
  | "pi_action_events"
  | "issue_supervisor_events"
  | "external_events"
  | "sync_outbox";

type EventRetentionPolicy = {
  archive_after_days: number | null;
  archive_minimum_days: number | null;
  event_class: EventRetentionClass;
  minimum_retention_days: number;
  require_archive_before_delete: boolean;
  require_summary_watermark: boolean;
  source_delete_after_days: number | null;
  tier: EventRetentionTier;
};

export type EventRetentionConfig = {
  execution_authorization: {
    actor_id: string;
    actor_kind: "user" | "retention_worker" | "system";
    audit_event_ref: string;
    authorized_at: string;
    observation_window_ref: string;
    policy_version: string;
    reason: string;
    restore_test_ref: string;
  } | null;
  execution_mode: "report_only" | "archive_only" | "delete_enabled";
  policies: Readonly<Record<EventRetentionPolicyID, EventRetentionPolicy>>;
  policy_version: typeof EVENT_RETENTION_POLICY_VERSION;
  schema_version: typeof EVENT_RETENTION_SCHEMA_VERSION;
};

export const DEFAULT_EVENT_RETENTION_CONFIG = {
  execution_authorization: null,
  execution_mode: "report_only",
  policies: {
    raw_operational: {
      archive_after_days: 7,
      archive_minimum_days: 365,
      event_class: "raw_log",
      minimum_retention_days: 7,
      require_archive_before_delete: true,
      require_summary_watermark: true,
      source_delete_after_days: 7,
      tier: "R1_OPERATIONAL"
    },
    raw_durable: {
      archive_after_days: 30,
      archive_minimum_days: 2555,
      event_class: "raw_log",
      minimum_retention_days: 30,
      require_archive_before_delete: true,
      require_summary_watermark: true,
      source_delete_after_days: 30,
      tier: "R2_DURABLE"
    },
    state_event: {
      archive_after_days: 365,
      archive_minimum_days: null,
      event_class: "state_event",
      minimum_retention_days: 365,
      require_archive_before_delete: true,
      require_summary_watermark: false,
      source_delete_after_days: null,
      tier: "R3_AUDIT"
    },
    audit_event: {
      archive_after_days: 365,
      archive_minimum_days: null,
      event_class: "audit_event",
      minimum_retention_days: 2555,
      require_archive_before_delete: true,
      require_summary_watermark: false,
      source_delete_after_days: null,
      tier: "R3_AUDIT"
    },
    delivery_evidence: {
      archive_after_days: 90,
      archive_minimum_days: null,
      event_class: "delivery_evidence",
      minimum_retention_days: 2555,
      require_archive_before_delete: true,
      require_summary_watermark: false,
      source_delete_after_days: null,
      tier: "R3_AUDIT"
    },
    review_required: {
      archive_after_days: null,
      archive_minimum_days: null,
      event_class: "review_required",
      minimum_retention_days: 0,
      require_archive_before_delete: true,
      require_summary_watermark: true,
      source_delete_after_days: null,
      tier: "REVIEW_REQUIRED"
    }
  },
  policy_version: EVENT_RETENTION_POLICY_VERSION,
  schema_version: EVENT_RETENTION_SCHEMA_VERSION
} as const satisfies EventRetentionConfig;

export type RetainedEvent = {
  created_at: string;
  event_type: string;
  id: number;
  issue_id?: number;
  issue_status?: string;
  project_id: string;
  raw_method?: string;
  run_id?: string;
  source: EventRetentionSource;
};

export type EventRetentionClassification = {
  event_class: EventRetentionClass;
  policy_id: EventRetentionPolicyID;
  tier: EventRetentionTier;
};

export type RetentionHold = {
  actor: string;
  audit_event_ref: string;
  created_at: string;
  expires_at?: string;
  id: string;
  kind: "pin" | "legal_hold";
  reason: string;
  released_at?: string;
  released_by?: string;
  release_audit_event_ref?: string;
  release_reason?: string;
  scope: "event" | "run" | "issue" | "project";
  scope_id: string;
  status: "active" | "released";
};

export type SummaryWatermark = {
  actor_id: string;
  audit_event_ref: string;
  contiguous: true;
  covered_through_event_id: number;
  issue_id: number;
  policy_id: EventRetentionPolicyID;
  policy_version: string;
  run_id: string;
  reason: string;
  schema_version: typeof SUMMARY_WATERMARK_SCHEMA_VERSION;
  source: EventRetentionSource;
  summary_ref: string;
  summary_sha256: string;
  verified_at: string;
  verifier: "deterministic_retention_worker";
};

export type ArchiveReceipt = {
  actor_id: string;
  archive_ref: string;
  audit_event_ref: string;
  contiguous: true;
  first_event_id: number;
  issue_id: number;
  manifest_sha256: string;
  policy_id: EventRetentionPolicyID;
  policy_version: string;
  restored_at: string;
  reason: string;
  row_count: number;
  run_id: string;
  schema_version: typeof ARCHIVE_RECEIPT_SCHEMA_VERSION;
  source: EventRetentionSource;
  through_event_id: number;
  verified_at: string;
  verifier: "deterministic_retention_worker";
};

export type DestructiveGate = {
  actor_id: string;
  actor_kind: "user" | "retention_worker" | "system";
  audit_event_ref: string;
  decision: "allow" | "deny";
  evaluated_at: string;
  policy_version: string;
  reason: string;
};

export type RetentionReferenceState = {
  handoff_evidence: boolean;
  unresolved_refs: string[];
};

export type RetentionRunState = {
  id: string;
  status: string;
};

const RETENTION_BLOCKER_CODES = [
  "invalid_event_timestamp",
  "review_required",
  "source_deletion_disabled",
  "minimum_retention_not_met",
  "pin",
  "legal_hold",
  "active_issue",
  "failed_issue",
  "pending_verification_issue",
  "needs_user_issue",
  "active_run",
  "failed_run",
  "non_successful_run",
  "run_state_unknown",
  "handoff_evidence",
  "unresolved_reference",
  "summary_watermark_missing",
  "summary_watermark_invalid",
  "archive_receipt_missing",
  "archive_receipt_invalid",
  "destructive_gate_missing",
  "destructive_gate_denied",
  "destructive_gate_invalid"
] as const;

export type RetentionBlockerCode = typeof RETENTION_BLOCKER_CODES[number];

export type RetentionEvaluation = {
  action: "keep" | "archive" | "delete_candidate";
  blockers: RetentionBlockerCode[];
  can_execute_delete: boolean;
  classification: EventRetentionClassification;
  event_age_days: number | null;
  policy: EventRetentionPolicy;
};

export type RetentionEvaluationInput = {
  archive_receipt?: ArchiveReceipt;
  config?: EventRetentionConfig;
  destructive_gate?: DestructiveGate;
  event: RetainedEvent;
  holds?: RetentionHold[];
  now: string;
  references?: RetentionReferenceState;
  run?: RetentionRunState;
  summary_watermark?: SummaryWatermark;
};
