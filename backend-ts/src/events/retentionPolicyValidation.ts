import {
  type EventRetentionConfig,
  EVENT_RETENTION_SCHEMA_VERSION,
  EVENT_RETENTION_POLICY_VERSION,
  EVENT_RETENTION_POLICY_IDS,
  DEFAULT_EVENT_RETENTION_CONFIG
} from "./retentionPolicyModel.ts";
import { validTimestamp } from "./retentionPolicyGates.ts";

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
