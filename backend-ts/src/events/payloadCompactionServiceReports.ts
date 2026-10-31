import { statSync } from "node:fs";
import { type IssueEventSnapshot } from "../db/repositories/eventMaintenance.ts";
import {
  type PayloadCheckpoint,
  ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
  withoutEventIDs,
  sameEventIDs
} from "./payloadCompactionServiceModel.ts";
import { quickCheckPath } from "./payloadCompactionServiceStorage.ts";

export function compactionReport(
  dbPath: string,
  _before: IssueEventSnapshot,
  after: IssueEventSnapshot,
  checkpoint: PayloadCheckpoint,
  dryRun: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    operation: "compact_issue_log_payloads",
    dry_run: dryRun,
    paused,
    database: { path: dbPath, file_bytes: statSync(dbPath).size, quick_check: quickCheckPath(dbPath) },
    minimum_savings_bytes: checkpoint.minimum_savings_bytes,
    plan: withoutEventIDs(checkpoint.plan),
    checkpoint: { cursor: checkpoint.cursor, status: checkpoint.status, total: checkpoint.event_ids.length },
    applied: checkpoint.applied,
    source_snapshot: checkpoint.source_snapshot,
    current_snapshot: after,
    destructive_changes: !dryRun
  };
}

export function restoreReport(
  dbPath: string,
  _before: IssueEventSnapshot,
  after: IssueEventSnapshot,
  checkpoint: PayloadCheckpoint,
  dryRun: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    operation: "restore_issue_log_payloads",
    dry_run: dryRun,
    paused,
    database: { path: dbPath, file_bytes: statSync(dbPath).size, quick_check: quickCheckPath(dbPath) },
    restore_rows: checkpoint.event_ids.length,
    checkpoint: { cursor: checkpoint.cursor, status: checkpoint.status, total: checkpoint.event_ids.length },
    applied: checkpoint.applied,
    source_snapshot: checkpoint.source_snapshot,
    current_snapshot: after,
    destructive_changes: !dryRun
  };
}

export function verifyCompactionCheckpoint(
  checkpoint: PayloadCheckpoint,
  dbPath: string,
  snapshot: IssueEventSnapshot,
  minimumSavingsBytes: number,
  resume: boolean
): void {
  if (checkpoint.database_path !== dbPath || checkpoint.minimum_savings_bytes !== minimumSavingsBytes) {
    throw new Error("compaction checkpoint inputs do not match");
  }
  if (checkpoint.source_snapshot.issue_event_count !== snapshot.issue_event_count ||
    checkpoint.source_snapshot.first_event_id !== snapshot.first_event_id ||
    checkpoint.source_snapshot.last_event_id !== snapshot.last_event_id) {
    throw new Error("issue_events identity snapshot changed after compaction planning");
  }
  if (resume && checkpoint.status === "complete") throw new Error("compaction checkpoint is already complete");
}

export function verifyRestoreCheckpoint(
  checkpoint: PayloadCheckpoint,
  dbPath: string,
  sourcePath: string,
  eventIDs: number[],
  resume: boolean
): void {
  if (checkpoint.database_path !== dbPath || checkpoint.source_checkpoint !== sourcePath ||
    !sameEventIDs(checkpoint.event_ids, eventIDs)) {
    throw new Error("restore checkpoint inputs do not match");
  }
  if (resume && checkpoint.status === "complete") throw new Error("restore checkpoint is already complete");
}
