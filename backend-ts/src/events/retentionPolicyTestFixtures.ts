import { resolve } from "node:path";
import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  SUMMARY_WATERMARK_SCHEMA_VERSION,
  type ArchiveReceipt,
  type DestructiveGate,
  type RetainedEvent,
  type SummaryWatermark
} from "./retentionPolicy.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export const ADR_PATH = resolve(REPO_ROOT, "docs/architecture/xuanwu/0007-event-retention-policy.md");

export const SHA_A = "a".repeat(64);

export const SHA_B = "b".repeat(64);

export function eventOf(eventType: string, rawMethod = ""): RetainedEvent {
  return {
    created_at: "2026-01-01T00:00:00Z",
    event_type: eventType,
    id: 100,
    issue_id: 638,
    project_id: "xuanwu",
    raw_method: rawMethod,
    run_id: "run-1",
    source: "issue_events"
  };
}

export function eligibleInput() {
  const event = eventOf("issue.log", "item/agentMessage/delta");
  const summaryWatermark: SummaryWatermark = {
    actor_id: "retention-worker-1",
    audit_event_ref: "pi_action_events:summary-run-1-120",
    contiguous: true,
    covered_through_event_id: 120,
    issue_id: event.issue_id!,
    policy_id: "raw_operational",
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "contiguous raw log summary verified",
    run_id: event.run_id!,
    schema_version: SUMMARY_WATERMARK_SCHEMA_VERSION,
    source: event.source,
    summary_ref: "issue_events_summary:run-1:120",
    summary_sha256: SHA_A,
    verified_at: "2026-03-01T00:00:00Z",
    verifier: "deterministic_retention_worker"
  };
  const archiveReceipt: ArchiveReceipt = {
    actor_id: "retention-worker-1",
    archive_ref: "archive:issue-638:run-1:1-120",
    audit_event_ref: "pi_action_events:archive-run-1-120",
    contiguous: true,
    first_event_id: 1,
    issue_id: event.issue_id!,
    manifest_sha256: SHA_B,
    policy_id: "raw_operational",
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "archive checksum and restore verified",
    restored_at: "2026-03-02T00:00:00Z",
    row_count: 120,
    run_id: event.run_id!,
    schema_version: ARCHIVE_RECEIPT_SCHEMA_VERSION,
    source: event.source,
    through_event_id: 120,
    verified_at: "2026-03-01T00:00:00Z",
    verifier: "deterministic_retention_worker"
  };
  const destructiveGate: DestructiveGate = {
    actor_id: "retention-worker-1",
    actor_kind: "retention_worker",
    audit_event_ref: "pi_action_events:retention-638-1",
    decision: "allow",
    evaluated_at: "2026-04-01T00:00:00Z",
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "all deterministic retention guards passed"
  };
  return {
    archive_receipt: archiveReceipt,
    destructive_gate: destructiveGate,
    event,
    now: "2026-04-01T00:00:00Z",
    references: { handoff_evidence: false, unresolved_refs: [] },
    run: { id: "run-1", status: "succeeded" },
    summary_watermark: summaryWatermark
  };
}
