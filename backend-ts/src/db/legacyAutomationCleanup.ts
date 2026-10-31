import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { recordMaintenanceAudit } from "./repositories/eventMaintenance.ts";
import {
  dropLegacyAutomationTables,
  LEGACY_AUTOMATION_DROP_MIGRATION_ID,
  LEGACY_AUTOMATION_DROP_TABLES
} from "./schema/053_drop_legacy_automation_tables.ts";
import { cleanString, errorMessage } from "../util/values.ts";
import {
  type LegacyAutomationCleanupInput,
  LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT
} from "./legacyAutomationCleanupModel.ts";
import {
  resolveRequired,
  assertDistinct,
  open,
  cleanupGate,
  authorize,
  requireConfirmations,
  requireExactTables,
  databaseHealth,
  rollbackLimit
} from "./legacyAutomationCleanupValidation.ts";
import {
  inventoryFor,
  archivePayload,
  writeJSON,
  createVerifiedBackup,
  archiveContentChecksum,
  writeAndVerifyArchive,
  tableExists,
  sha256File
} from "./legacyAutomationCleanupArchive.ts";

export function cleanupLegacyAutomationSchema(input: LegacyAutomationCleanupInput): Record<string, unknown> {
  const dbPath = resolveRequired(input.dbPath, "--db");
  const reportPath = resolveRequired(input.reportPath, "--report");
  assertDistinct(dbPath, reportPath);
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  const beforeBytes = statSync(dbPath).size;
  const sqlite = open(dbPath, !input.apply);
  try {
    const inventory = inventoryFor(sqlite);
    const archiveCandidate = archivePayload(sqlite, dbPath, inventory);
    const gate = cleanupGate(dbPath, sourceRoot, input.releaseRef);
    const preflight = baseReport(dbPath, beforeBytes, inventory, archiveCandidate, gate, input.apply ? "apply" : "preflight");
    if (!input.apply) {
      writeJSON(reportPath, preflight);
      return preflight;
    }

    const authorization = authorize(input);
    requireConfirmations(input);
    requireExactTables(input.confirmTables);
    if (!gate.passed) throw new Error(`legacy Automation drop blocked: ${gate.blockers.join("; ")}`);
    const backupPath = resolveRequired(input.backupPath, "--backup");
    const archivePath = resolveRequired(input.archivePath, "--archive");
    assertDistinct(dbPath, reportPath, backupPath, archivePath);
    if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
    if (existsSync(archivePath)) throw new Error(`archive already exists: ${archivePath}`);

    const backup = createVerifiedBackup(sqlite, backupPath, archiveContentChecksum(archiveCandidate.payload));
    const archive = writeAndVerifyArchive(archivePath, archiveCandidate);
    const actionID = `legacy-automation-drop:${randomUUID()}`;
    const auditPayload = {
      actor_kind: authorization.actorKind,
      archive_path: archivePath,
      archive_sha256: archive.archive_sha256,
      audit_ref: authorization.auditRef,
      backup_path: backupPath,
      backup_sha256: backup.sha256,
      release_ref: cleanString(input.releaseRef),
      tables: [...LEGACY_AUTOMATION_DROP_TABLES]
    };
    const apply = sqlite.transaction(() => {
      recordMaintenanceAudit(sqlite, {
        actionID,
        actor: authorization.actor,
        decision: "allow",
        eventType: "db.legacy_automation_drop_started",
        reason: authorization.reason,
        result: auditPayload
      });
      dropLegacyAutomationTables(sqlite);
      sqlite.run("insert or ignore into schema_migrations (id) values (?)", [LEGACY_AUTOMATION_DROP_MIGRATION_ID]);
    });
    apply.immediate();
    sqlite.run("vacuum");
    const health = databaseHealth(sqlite);
    const remaining = LEGACY_AUTOMATION_DROP_TABLES.filter((table) => tableExists(sqlite, table));
    if (remaining.length > 0 || health.quick_check !== "ok" || health.foreign_key_violations !== 0) {
      throw new Error(`post-drop validation failed: remaining=${remaining.join(",") || "none"}, quick_check=${health.quick_check}, foreign_keys=${health.foreign_key_violations}`);
    }
    const afterBytes = statSync(dbPath).size;
    const report = {
      ...preflight,
      outcome: "applied",
      archive,
      backup,
      audit: { action_id: actionID, ...auditPayload },
      database: { ...health, sha256: sha256File(dbPath) },
      file_size: {
        after_bytes: afterBytes,
        before_bytes: beforeBytes,
        delta_bytes: afterBytes - beforeBytes,
        reclaimed_bytes: Math.max(0, beforeBytes - afterBytes)
      },
      removed_indexes: inventory.indexes.map((index) => index.name),
      removed_tables: [...LEGACY_AUTOMATION_DROP_TABLES],
      rollback: rollbackLimit(backupPath)
    };
    recordMaintenanceAudit(sqlite, {
      actionID,
      actor: authorization.actor,
      decision: "allow",
      eventType: "db.legacy_automation_drop_completed",
      reason: authorization.reason,
      result: report
    });
    writeJSON(reportPath, report);
    return report;
  } catch (error) {
    const failure = {
      contract: LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT,
      database_path: dbPath,
      error: errorMessage(error),
      generated_at: new Date().toISOString(),
      operation: input.apply ? "apply" : "preflight",
      outcome: "blocked"
    };
    writeJSON(reportPath, failure);
    throw error;
  } finally {
    sqlite.close();
  }
}

function baseReport(
  dbPath: string,
  beforeBytes: number,
  inventory: ReturnType<typeof inventoryFor>,
  archive: ReturnType<typeof archivePayload>,
  gate: ReturnType<typeof cleanupGate>,
  operation: string
) {
  return {
    contract: LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT,
    archive_candidate: { checksum_sha256: archive.checksum_sha256 },
    database_path: dbPath,
    file_size: { before_bytes: beforeBytes },
    gate,
    generated_at: new Date().toISOString(),
    inventory,
    operation,
    outcome: gate.passed ? "ready" : "blocked",
    rollback: rollbackLimit("<fresh-backup.db>")
  };
}

export { verifyLegacyAutomationArchive } from "./legacyAutomationCleanupArchive.ts";
