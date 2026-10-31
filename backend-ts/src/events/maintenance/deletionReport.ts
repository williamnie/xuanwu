import type { CountMap, DatabaseMeasurement } from "./common.ts";
import { type MaintenanceCheckpoint } from "./deletionModel.ts";

export function deleteReport(
  dbPath: string,
  before: DatabaseMeasurement,
  after: DatabaseMeasurement,
  checkpoint: MaintenanceCheckpoint,
  blockers: CountMap,
  applied: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation: "delete",
    dry_run: !applied,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, before, after },
    eligible_rows: checkpoint.event_ids.length,
    deleted_rows: applied ? checkpoint.cursor : 0,
    blockers,
    checkpoint: { status: checkpoint.status, cursor: checkpoint.cursor, total: checkpoint.event_ids.length },
    source_of_truth: "issue_events",
    rollback: "maintenance events restore"
  };
}
