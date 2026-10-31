import {
  type RetentionBlockerCode,
  type RetainedEvent,
  type RetentionHold,
  type RetentionRunState,
  type DestructiveGate,
  type EventRetentionConfig,
  type EventRetentionClassification,
  type SummaryWatermark,
  SUMMARY_WATERMARK_SCHEMA_VERSION,
  type ArchiveReceipt,
  ARCHIVE_RECEIPT_SCHEMA_VERSION
} from "./retentionPolicyModel.ts";
import { ACTIVE_RUN_STATUSES, SUCCESSFUL_RUN_STATUSES } from "./retentionPolicyClassification.ts";

export function addIssueBlocker(blockers: RetentionBlockerCode[], value: string | undefined): void {
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

export function addRunBlocker(
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

export function addDestructiveGateBlocker(
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

export function holdApplies(hold: RetentionHold, event: RetainedEvent, now: string): boolean {
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

export function validSummaryWatermark(
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

export function validArchiveReceipt(event: RetainedEvent, receipt: ArchiveReceipt | undefined, config: EventRetentionConfig): boolean {
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

export function eventAgeDays(createdAt: string, now: string): number | null {
  if (!validTimestamp(createdAt) || !validTimestamp(now)) return null;
  const age = (Date.parse(now) - Date.parse(createdAt)) / 86_400_000;
  return Number.isFinite(age) && age >= 0 ? Math.floor(age * 1000) / 1000 : null;
}

export function validTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}
