import {
  type RetentionEvaluationInput,
  type RetentionEvaluation,
  DEFAULT_EVENT_RETENTION_CONFIG,
  type RetentionBlockerCode
} from "./retentionPolicyModel.ts";
import { validateEventRetentionConfig } from "./retentionPolicyValidation.ts";
import { classifyEventRetention } from "./retentionPolicyClassification.ts";
import {
  eventAgeDays,
  holdApplies,
  addIssueBlocker,
  addRunBlocker,
  validSummaryWatermark,
  validArchiveReceipt,
  addDestructiveGateBlocker
} from "./retentionPolicyGates.ts";

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

export { EVENT_RETENTION_SCHEMA_VERSION } from "./retentionPolicyModel.ts";
export { EVENT_RETENTION_POLICY_VERSION } from "./retentionPolicyModel.ts";
export { SUMMARY_WATERMARK_SCHEMA_VERSION } from "./retentionPolicyModel.ts";
export { ARCHIVE_RECEIPT_SCHEMA_VERSION } from "./retentionPolicyModel.ts";
export { EVENT_RETENTION_POLICY_IDS } from "./retentionPolicyModel.ts";
export type { EventRetentionPolicyID } from "./retentionPolicyModel.ts";
export type { EventRetentionConfig } from "./retentionPolicyModel.ts";
export { DEFAULT_EVENT_RETENTION_CONFIG } from "./retentionPolicyModel.ts";
export type { RetainedEvent } from "./retentionPolicyModel.ts";
export type { RetentionHold } from "./retentionPolicyModel.ts";
export type { SummaryWatermark } from "./retentionPolicyModel.ts";
export type { ArchiveReceipt } from "./retentionPolicyModel.ts";
export type { DestructiveGate } from "./retentionPolicyModel.ts";
export type { RetentionReferenceState } from "./retentionPolicyModel.ts";
export { classifyEventRetention } from "./retentionPolicyClassification.ts";
export { retentionScopeID } from "./retentionPolicyGates.ts";
export { validateEventRetentionConfig } from "./retentionPolicyValidation.ts";
