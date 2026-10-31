import { type IssueEventSnapshot } from "../db/repositories/eventMaintenance.ts";

export const ISSUE_LOG_COMPACTION_SCHEMA_VERSION = "xuanwu.issue-log-payload-compaction.v1" as const;

export const DEFAULT_ISSUE_LOG_COMPACTION_MINIMUM_SAVINGS_BYTES = 4096;

export type MaintenanceActor = { actor: string; auditRef: string; reason: string };

export type PayloadRow = { id: number; payload: string };

export type CompactionPlan = {
  artifact_4k_blocks_bytes: number;
  artifact_bytes: number;
  candidate_rows: number;
  estimated_net_reclaimable_bytes: number;
  estimated_physical_net_reclaimable_bytes: number;
  event_ids: number[];
  new_artifacts: number;
  source_payload_bytes: number;
  stored_payload_bytes: number;
  unique_artifacts: number;
};

type AppliedStats = {
  artifact_bytes_created: number;
  artifacts_created: number;
  source_payload_bytes: number;
  stored_payload_bytes: number;
};

export type PayloadCheckpoint = {
  applied: AppliedStats;
  completed_at: string;
  created_at: string;
  cursor: number;
  database_path: string;
  event_ids: number[];
  minimum_savings_bytes: number;
  operation: "compact" | "restore";
  plan: CompactionPlan;
  schema_version: typeof ISSUE_LOG_COMPACTION_SCHEMA_VERSION;
  source_checkpoint?: string;
  source_snapshot: IssueEventSnapshot;
  status: "in_progress" | "paused" | "complete";
};

export function withoutEventIDs(plan: CompactionPlan): Omit<CompactionPlan, "event_ids"> {
  const { event_ids: _, ...summary } = plan;
  return summary;
}

export function emptyAppliedStats(): AppliedStats {
  return { artifact_bytes_created: 0, artifacts_created: 0, source_payload_bytes: 0, stored_payload_bytes: 0 };
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function sameEventIDs(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function ascendingPositiveEventIDs(values: number[]): boolean {
  return values.every((value, index) => Number.isSafeInteger(value) && value > 0 &&
    (index === 0 || value > values[index - 1]!));
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
