import { Database } from "bun:sqlite";
import { quickCheck, runVacuum, walCheckpoint } from "../../db/repositories/eventMaintenance.ts";
import { sqliteObjectUsage } from "../../db/sqliteObjectUsage.ts";
import type { DatabaseMeasurement, MaintenanceActor } from "./common.ts";
import {
  audit, databaseReport, existingDatabasePath, openReadonly, openWritable, requireDiskSpace,
  requireWriteConfirmations, validateActor, writeRequiredReport
} from "./common.ts";

/** Event maintenance step 3: WAL checkpoint and vacuum with before/after space reports. */

export function checkpointEventDatabase(input: {
  actor: MaintenanceActor;
  apply?: boolean;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  mode: "passive" | "full" | "restart" | "truncate";
  reportPath: string;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const before = databaseReport(dbPath, sqlite);
    if (!input.apply) {
      const report = dbMaintenanceReport("checkpoint", dbPath, true, false, before, before, { mode: input.mode });
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.checkpoint_started", "allow", { mode: input.mode });
    const result = walCheckpoint(sqlite, input.mode);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.checkpoint_completed", "allow", result);
    const report = dbMaintenanceReport("checkpoint", dbPath, false, false, before, databaseReport(dbPath, sqlite), result);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function vacuumEventDatabase(input: {
  actor: MaintenanceActor;
  apply?: boolean;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  enableIncremental?: boolean;
  mode: "full" | "incremental";
  pages?: number;
  reportPath: string;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const before = databaseReport(dbPath, sqlite);
    const details = { mode: input.mode, pages: input.pages ?? null, enable_incremental: Boolean(input.enableIncremental) };
    if (!input.apply) {
      const report = dbMaintenanceReport("vacuum", dbPath, true, false, before, before, details);
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    if (input.mode === "full") requireDiskSpace(dbPath, before.file_bytes, "full vacuum");
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_started", "allow", details);
    runVacuum(sqlite, { mode: input.mode, pages: input.pages, enableIncremental: Boolean(input.enableIncremental) });
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-vacuum quick_check failed: ${integrity}`);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_completed", "allow", { ...details, quick_check: integrity });
    const after = databaseReport(dbPath, sqlite);
    const targetBytes = 400 * 1024 * 1024;
    const report = dbMaintenanceReport("vacuum", dbPath, false, false, before, after, {
      ...details,
      quick_check: integrity,
      target: {
        maximum_bytes: targetBytes,
        passed: after.file_bytes <= targetBytes,
        ...(after.file_bytes > targetBytes ? { alert: "database remains above 400 MiB; inspect object_usage before any further deletion", object_usage: databaseObjectUsage(sqlite) } : {})
      }
    });
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

function dbMaintenanceReport(
  operation: "checkpoint" | "vacuum",
  dbPath: string,
  dryRun: boolean,
  paused: boolean,
  before: DatabaseMeasurement,
  after: DatabaseMeasurement,
  details: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation,
    dry_run: dryRun,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, before, after },
    details
  };
}

function databaseObjectUsage(sqlite: Database): Array<{ bytes: number; name: string }> {
  return sqliteObjectUsage(sqlite);
}
