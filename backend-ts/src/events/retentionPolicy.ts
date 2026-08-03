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
export type EventRetentionClass = "raw_log" | "state_event" | "audit_event" | "delivery_evidence" | "review_required";
export type EventRetentionSource =
  | "issue_events"
  | "pi_action_events"
  | "issue_supervisor_events"
  | "external_events"
  | "sync_outbox";

export type EventRetentionPolicy = {
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

export const RETENTION_BLOCKER_CODES = [
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

const OPERATIONAL_METHOD = /(?:delta|updated|tokenusage|moderationmetadata|startupstatus|terminalinteraction|thread\/goal\/cleared)/i;
const DURABLE_METHOD = /^(?:item\/started|item\/completed)$/i;
const AUDIT_METHOD = /(?:turn\/(?:started|completed)|thread\/status\/changed|error|approval)/i;
const DELIVERY_EVENT_TYPES = new Set(["issue.verification_report", "issue.verification_reviewed"]);
const STATE_EVENT_TYPES = new Set([
  "issue.human_review_response_applied.v1",
  "issue.created",
  "issue.status_changed",
  "issue.provider_deferred",
  "issue.recovery_deferred",
  "issue.recovery_requeued",
  "issue.recovery_started",
  "issue.recovery_turn_started",
  "issue.retry_after_scheduled",
  "issue.state_manager_repair",
  "issue.supervisor_resume_followup",
  "issue.supervisor_retry",
  "issue.watchdog_kicked",
  "issue.watchdog_needs_user",
  "issue.watchdog_waiting"
]);
const AUDIT_EVENT_TYPES = new Set([
  "issue.comment",
  "issue.error",
  "issue.interrupt_failed",
  "issue.interrupt_requested",
  "issue.interrupted",
  "issue.recovery_failed",
  "issue.supervisor_decision"
]);
const ACTIVE_RUN_STATUSES = new Set(["created", "in_progress", "recovering", "running"]);
const SUCCESSFUL_RUN_STATUSES = new Set(["completed", "done", "succeeded", "success"]);

export function classifyIssueLogRetentionTier(rawMethod: string): EventRetentionTier {
  if (AUDIT_METHOD.test(rawMethod)) return "R3_AUDIT";
  if (DURABLE_METHOD.test(rawMethod)) return "R2_DURABLE";
  if (OPERATIONAL_METHOD.test(rawMethod)) return "R1_OPERATIONAL";
  return "REVIEW_REQUIRED";
}

export function classifyEventRetention(event: Pick<RetainedEvent, "event_type" | "raw_method" | "source">): EventRetentionClassification {
  if (event.source === "sync_outbox") return classification("delivery_evidence");
  if (["external_events", "issue_supervisor_events", "pi_action_events"].includes(event.source)) {
    return classification("audit_event");
  }
  if (event.source !== "issue_events") return classification("review_required");
  if (event.event_type === "issue.log") {
    const tier = classifyIssueLogRetentionTier(event.raw_method ?? "");
    if (tier === "R1_OPERATIONAL") return classification("raw_operational");
    if (tier === "R2_DURABLE") return classification("raw_durable");
    if (tier === "R3_AUDIT") return classification("audit_event");
    return classification("review_required");
  }
  if (DELIVERY_EVENT_TYPES.has(event.event_type)) return classification("delivery_evidence");
  if (STATE_EVENT_TYPES.has(event.event_type)) return classification("state_event");
  if (AUDIT_EVENT_TYPES.has(event.event_type)) return classification("audit_event");
  return classification("review_required");
}

export function evaluateEventRetention(input: RetentionEvaluationInput): RetentionEvaluation {
  const config = input.config ?? DEFAULT_EVENT_RETENTION_CONFIG;
  const configErrors = validateEventRetentionConfig(config);
  if (configErrors.length > 0) throw new Error(`invalid event retention config: ${configErrors.join("; ")}`);
  const classificationResult = classifyEventRetention(input.event);
  const policy = config.policies[classificationResult.policy_id];
  const ageDays = eventAgeDays(input.event.created_at, input.now);
  const blockers: RetentionBlockerCode[] = [];

  if (ageDays === null) blockers.push("invalid_event_timestamp");
  if (classificationResult.policy_id === "review_required") blockers.push("review_required");
  if (policy.source_delete_after_days === null) blockers.push("source_deletion_disabled");
  else if (ageDays === null || ageDays < policy.source_delete_after_days) blockers.push("minimum_retention_not_met");

  const activeHolds = (input.holds ?? []).filter((hold) => holdApplies(hold, input.event, input.now));
  if (activeHolds.some((hold) => hold.kind === "pin")) blockers.push("pin");
  if (activeHolds.some((hold) => hold.kind === "legal_hold")) blockers.push("legal_hold");

  addIssueBlocker(blockers, input.event.issue_status);

  if (classificationResult.event_class === "raw_log") addRunBlocker(blockers, input.event, input.run);
  if (input.references?.handoff_evidence) blockers.push("handoff_evidence");
  if ((input.references?.unresolved_refs.length ?? 0) > 0) blockers.push("unresolved_reference");

  if (policy.require_summary_watermark) {
    if (!input.summary_watermark) blockers.push("summary_watermark_missing");
    else if (!validSummaryWatermark(input.event, classificationResult, input.summary_watermark, config)) {
      blockers.push("summary_watermark_invalid");
    }
  }
  if (policy.require_archive_before_delete) {
    if (!input.archive_receipt) blockers.push("archive_receipt_missing");
    else if (!validArchiveReceipt(input.event, input.archive_receipt, config)) blockers.push("archive_receipt_invalid");
  }
  addDestructiveGateBlocker(blockers, input.destructive_gate, config);

  const uniqueBlockers = [...new Set(blockers)];
  const issueProtected = blockers.some((blocker) =>
    blocker === "active_issue" || blocker === "failed_issue" ||
    blocker === "pending_verification_issue" || blocker === "needs_user_issue");
  const archiveDue = !issueProtected && policy.archive_after_days !== null && ageDays !== null && ageDays >= policy.archive_after_days &&
    !validArchiveReceipt(input.event, input.archive_receipt, config);
  const action = uniqueBlockers.length === 0 ? "delete_candidate" : archiveDue ? "archive" : "keep";
  return {
    action,
    blockers: uniqueBlockers,
    can_execute_delete: action === "delete_candidate" && config.execution_mode === "delete_enabled",
    classification: classificationResult,
    event_age_days: ageDays,
    policy
  };
}

function addIssueBlocker(blockers: RetentionBlockerCode[], value: string | undefined): void {
  const status = value?.trim().toLowerCase() ?? "";
  if (["triage", "todo", "ready", "in_progress"].includes(status)) blockers.push("active_issue");
  else if (status === "failed") blockers.push("failed_issue");
  else if (status === "pending_verification") blockers.push("pending_verification_issue");
  else if (status === "needs_user") blockers.push("needs_user_issue");
}

export function retentionScopeID(event: RetainedEvent, scope: RetentionHold["scope"]): string {
  if (scope === "event") return `${event.source}:${event.id}`;
  if (scope === "run") return event.run_id ?? "";
  if (scope === "issue") return event.issue_id === undefined ? "" : String(event.issue_id);
  return event.project_id;
}

export function validateEventRetentionConfig(config: EventRetentionConfig): string[] {
  const errors: string[] = [];
  if (config.schema_version !== EVENT_RETENTION_SCHEMA_VERSION) errors.push("schema_version is unsupported");
  if (config.policy_version !== EVENT_RETENTION_POLICY_VERSION) errors.push("policy_version is unsupported");
  if (!["report_only", "archive_only", "delete_enabled"].includes(config.execution_mode)) errors.push("execution_mode is invalid");
  const authorization = config.execution_authorization;
  if (config.execution_mode !== "report_only" && (!authorization || !authorization.actor_id.trim() ||
    !["user", "retention_worker", "system"].includes(authorization.actor_kind) ||
    !authorization.audit_event_ref.trim() || !authorization.reason.trim() ||
    authorization.policy_version !== config.policy_version || !validTimestamp(authorization.authorized_at))) {
    errors.push("non-report execution requires audited authorization");
  }
  if (config.execution_mode === "delete_enabled" && (!authorization?.observation_window_ref.trim() ||
    !authorization.restore_test_ref.trim())) {
    errors.push("delete_enabled requires observation and restore evidence");
  }
  for (const id of EVENT_RETENTION_POLICY_IDS) {
    const policy = config.policies[id];
    if (!policy) {
      errors.push(`${id} policy is required`);
      continue;
    }
    const canonical = DEFAULT_EVENT_RETENTION_CONFIG.policies[id];
    if (policy.event_class !== canonical.event_class || policy.tier !== canonical.tier) {
      errors.push(`${id} event_class and tier are immutable`);
    }
    for (const [name, value] of [
      ["archive_after_days", policy.archive_after_days],
      ["archive_minimum_days", policy.archive_minimum_days],
      ["minimum_retention_days", policy.minimum_retention_days],
      ["source_delete_after_days", policy.source_delete_after_days]
    ] as const) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) errors.push(`${id}.${name} must be a non-negative integer or null`);
    }
    if (policy.source_delete_after_days !== null && policy.source_delete_after_days < policy.minimum_retention_days) {
      errors.push(`${id}.source_delete_after_days must cover minimum_retention_days`);
    }
    if (policy.minimum_retention_days < canonical.minimum_retention_days) {
      errors.push(`${id}.minimum_retention_days must not be shorter than the canonical default`);
    }
    if (canonical.archive_minimum_days !== null && policy.archive_minimum_days !== null &&
      policy.archive_minimum_days < canonical.archive_minimum_days) {
      errors.push(`${id}.archive_minimum_days must not be shorter than the canonical default`);
    }
    if (canonical.source_delete_after_days !== null && policy.source_delete_after_days !== null &&
      policy.source_delete_after_days < canonical.source_delete_after_days) {
      errors.push(`${id}.source_delete_after_days must not be shorter than the canonical default`);
    }
    if (policy.source_delete_after_days !== null && policy.archive_after_days !== null &&
      policy.archive_after_days > policy.source_delete_after_days) {
      errors.push(`${id}.archive_after_days must not exceed source_delete_after_days`);
    }
  }
  for (const id of ["raw_operational", "raw_durable"] as const) {
    const policy = config.policies[id];
    if (!policy.require_archive_before_delete || !policy.require_summary_watermark) {
      errors.push(`${id} deletion requires archive and summary watermark`);
    }
  }
  for (const id of ["state_event", "audit_event", "delivery_evidence", "review_required"] as const) {
    if (config.policies[id].source_delete_after_days !== null) errors.push(`${id} source deletion must be disabled`);
  }
  return errors;
}

function classification(policyID: EventRetentionPolicyID): EventRetentionClassification {
  const policy = DEFAULT_EVENT_RETENTION_CONFIG.policies[policyID];
  return { event_class: policy.event_class, policy_id: policyID, tier: policy.tier };
}

function addRunBlocker(
  blockers: RetentionBlockerCode[],
  event: RetainedEvent,
  run: RetentionRunState | undefined
): void {
  if (!run?.id.trim() || !run.status.trim() || (event.run_id !== undefined && event.run_id !== run.id)) {
    blockers.push("run_state_unknown");
    return;
  }
  const status = run.status.trim().toLowerCase();
  if (ACTIVE_RUN_STATUSES.has(status)) blockers.push("active_run");
  else if (status === "failed") blockers.push("failed_run");
  else if (!SUCCESSFUL_RUN_STATUSES.has(status)) blockers.push("non_successful_run");
}

function addDestructiveGateBlocker(
  blockers: RetentionBlockerCode[],
  gate: DestructiveGate | undefined,
  config: EventRetentionConfig
): void {
  if (!gate) {
    blockers.push("destructive_gate_missing");
    return;
  }
  if (gate.decision === "deny") {
    blockers.push("destructive_gate_denied");
    return;
  }
  if (!gate.actor_id.trim() || !["user", "retention_worker", "system"].includes(gate.actor_kind) ||
    !gate.audit_event_ref.trim() || !gate.reason.trim() ||
    gate.policy_version !== config.policy_version || !validTimestamp(gate.evaluated_at)) {
    blockers.push("destructive_gate_invalid");
  }
}

function holdApplies(hold: RetentionHold, event: RetainedEvent, now: string): boolean {
  if (hold.scope_id !== retentionScopeID(event, hold.scope)) return false;
  if (hold.status === "released") return !validHoldRelease(hold, now);
  if (hold.kind === "legal_hold") return true;
  return !hold.expires_at || !validTimestamp(hold.expires_at) || Date.parse(hold.expires_at) > Date.parse(now);
}

function validHoldRelease(hold: RetentionHold, now: string): boolean {
  return Boolean(hold.released_by?.trim()) && Boolean(hold.release_reason?.trim()) &&
    Boolean(hold.release_audit_event_ref?.trim()) && Boolean(hold.released_at && validTimestamp(hold.released_at)) &&
    validTimestamp(now) && Date.parse(hold.released_at!) <= Date.parse(now);
}

function validSummaryWatermark(
  event: RetainedEvent,
  classificationResult: EventRetentionClassification,
  watermark: SummaryWatermark | undefined,
  config: EventRetentionConfig
): boolean {
  if (!watermark) return false;
  return watermark.schema_version === SUMMARY_WATERMARK_SCHEMA_VERSION &&
    watermark.source === event.source && watermark.issue_id === event.issue_id &&
    watermark.run_id === (event.run_id ?? "") && watermark.policy_id === classificationResult.policy_id &&
    watermark.policy_version === config.policy_version && watermark.covered_through_event_id >= event.id &&
    watermark.contiguous === true && watermark.verifier === "deterministic_retention_worker" &&
    watermark.actor_id.trim() !== "" && watermark.audit_event_ref.trim() !== "" && watermark.reason.trim() !== "" &&
    watermark.summary_ref.trim() !== "" && /^[a-f0-9]{64}$/i.test(watermark.summary_sha256) &&
    validTimestamp(watermark.verified_at);
}

function validArchiveReceipt(event: RetainedEvent, receipt: ArchiveReceipt | undefined, config: EventRetentionConfig): boolean {
  if (!receipt) return false;
  return receipt.schema_version === ARCHIVE_RECEIPT_SCHEMA_VERSION &&
    receipt.source === event.source && receipt.issue_id === event.issue_id &&
    receipt.run_id === (event.run_id ?? "") && receipt.policy_version === config.policy_version &&
    receipt.first_event_id <= event.id && receipt.through_event_id >= event.id && receipt.row_count > 0 &&
    receipt.contiguous === true && receipt.verifier === "deterministic_retention_worker" &&
    receipt.actor_id.trim() !== "" && receipt.audit_event_ref.trim() !== "" && receipt.reason.trim() !== "" &&
    receipt.archive_ref.trim() !== "" && /^[a-f0-9]{64}$/i.test(receipt.manifest_sha256) &&
    validTimestamp(receipt.verified_at) && validTimestamp(receipt.restored_at);
}

function eventAgeDays(createdAt: string, now: string): number | null {
  if (!validTimestamp(createdAt) || !validTimestamp(now)) return null;
  const age = (Date.parse(now) - Date.parse(createdAt)) / 86_400_000;
  return Number.isFinite(age) && age >= 0 ? Math.floor(age * 1000) / 1000 : null;
}

function validTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}
