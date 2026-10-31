import { type IssueEventSnapshot } from "../../db/repositories/eventMaintenance.ts";
import {
  type DestructiveGate,
  type EventRetentionConfig,
  type EventRetentionPolicyID,
  type RetentionHold,
  type RetentionReferenceState,
  type SummaryWatermark
} from "../retentionPolicy.ts";
import type { CountMap } from "./common.ts";

/** Event maintenance step 2: delete evidence, checkpointed deletion of archived rows, and restore from the archive. */
export const EVENT_DELETE_EVIDENCE_SCHEMA_VERSION = "xuanwu.event-maintenance-delete-evidence.v1" as const;

export const EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION = "xuanwu.event-maintenance-checkpoint.v1" as const;

export type EventDeleteEvidence = {
  archive_manifest_sha256: string;
  backup: { created_at: string; db_file: string; quick_check: "ok"; restored_at: string; verified_at: string };
  config: EventRetentionConfig;
  consumer_zero: { compact_last_event_id: number; projection_read_version: "v2"; verified_at: string };
  correlation_id: string;
  holds: RetentionHold[];
  schema_version: typeof EVENT_DELETE_EVIDENCE_SCHEMA_VERSION;
  scopes: Array<{
    destructive_gate: DestructiveGate;
    issue_id: number;
    policy_id: EventRetentionPolicyID;
    references: RetentionReferenceState;
    run_id: string;
    summary_watermark: SummaryWatermark;
  }>;
  source_snapshot: IssueEventSnapshot;
  writer_quiesce: { active_writers: 0; confirmed_by: string; verified_at: string };
};

export type MaintenanceCheckpoint = {
  archive_manifest_sha256: string;
  blockers: CountMap;
  completed_at: string;
  created_at: string;
  cursor: number;
  evidence_sha256: string;
  event_ids: number[];
  operation: "delete" | "restore";
  schema_version: typeof EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION;
  status: "in_progress" | "paused" | "complete";
};
