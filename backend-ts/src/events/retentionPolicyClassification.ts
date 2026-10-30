import {
  type EventRetentionTier,
  type RetainedEvent,
  type EventRetentionClassification,
  type EventRetentionPolicyID,
  DEFAULT_EVENT_RETENTION_CONFIG
} from "./retentionPolicyModel.ts";

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

export const ACTIVE_RUN_STATUSES = new Set(["created", "in_progress", "recovering", "running"]);

export const SUCCESSFUL_RUN_STATUSES = new Set(["completed", "done", "succeeded", "success"]);

function classifyIssueLogRetentionTier(rawMethod: string): EventRetentionTier {
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

function classification(policyID: EventRetentionPolicyID): EventRetentionClassification {
  const policy = DEFAULT_EVENT_RETENTION_CONFIG.policies[policyID];
  return { event_class: policy.event_class, policy_id: policyID, tier: policy.tier };
}
