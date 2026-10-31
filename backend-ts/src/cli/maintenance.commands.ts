import { archiveEventMaintenance, previewEventMaintenance, verifyEventArchive } from "../events/maintenance/archive.ts";
import { checkpointEventDatabase, vacuumEventDatabase } from "../events/maintenance/database.ts";
import { deleteArchivedEvents, prepareEventDeleteEvidence, restoreArchivedEvents } from "../events/maintenance/deletion.ts";
import { rebuildEventSummaryProjection } from "../events/eventSummaryProjectionService.ts";
import { cutoverCompactEventSummaryProjection, observeCompactEventSummaryProjection, rebuildCompactEventSummaryProjection, retireLegacyEventSummaryProjection, rollbackCompactEventSummaryProjection, verifyCompactEventSummaryProjection } from "../events/compactEventSummaryProjectionService.ts";
import { compactHistoricalIssueLogPayloads, restoreHistoricalIssueLogPayloads } from "../events/payloadCompactionService.ts";
import { auditPiDecisionConsolidation } from "../domain/attention/consolidationAudit.ts";
import { forwardDatabaseMigration, preflightDatabaseMigration, rollbackDatabaseMigration } from "../db/migrationRehearsal.ts";
import { cleanupLegacyAutomationSchema, verifyLegacyAutomationArchive } from "../db/legacyAutomationCleanup.ts";
import { runWalMaintenance } from "../db/walMaintenance.ts";
import type { Command } from "./maintenance.model.ts";
import { required, ATTRIBUTED_FLAGS, BATCH_FLAGS, attributedActor, batch, optionalInteger, GATE_FLAGS, gate, optionalNonNegativeInteger, ACTOR_FLAGS, optionalActor, actor, actorKind, oneOf, enabled, optionalAttribution, migrationInput } from "./maintenance.arguments.ts";

export const COMMANDS: Record<string, Command> = {
  "events report": {
    flags: ["before", "db", "now", "report"],
    run: (f) => previewEventMaintenance({ dbPath: required(f, "db"), before: f.before, now: f.now, reportPath: f.report })
  },
  "events rebuild-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...BATCH_FLAGS, "db"],
    run: (f) => rebuildEventSummaryProjection({ ...attributedActor(f), ...batch(f), dbPath: required(f, "db") })
  },
  "events rebuild-compact-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...BATCH_FLAGS, "db"],
    run: (f) => rebuildCompactEventSummaryProjection({ ...attributedActor(f), ...batch(f), dbPath: required(f, "db") })
  },
  "events verify-compact-projection": {
    flags: ["db", "performance-samples"],
    run: (f) => verifyCompactEventSummaryProjection({
      dbPath: required(f, "db"),
      performanceSamples: optionalInteger(f["performance-samples"], "--performance-samples")
    })
  },
  "events observe-compact-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "db", "duration-seconds"],
    run: (f) => observeCompactEventSummaryProjection({
      ...attributedActor(f), ...gate(f), dbPath: required(f, "db"),
      durationSeconds: optionalNonNegativeInteger(f["duration-seconds"], "--duration-seconds")
    })
  },
  "events cutover-compact-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "db", "minimum-observation-seconds"],
    run: (f) => cutoverCompactEventSummaryProjection({
      ...attributedActor(f), ...gate(f), dbPath: required(f, "db"),
      minimumObservationSeconds: optionalNonNegativeInteger(f["minimum-observation-seconds"], "--minimum-observation-seconds")
    })
  },
  "events rollback-compact-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "db"],
    run: (f) => rollbackCompactEventSummaryProjection({ ...attributedActor(f), ...gate(f), dbPath: required(f, "db") })
  },
  "events retire-legacy-projection": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "db"],
    run: (f) => retireLegacyEventSummaryProjection({ ...attributedActor(f), ...gate(f), dbPath: required(f, "db") })
  },
  "events compact-payloads": {
    flags: [...ACTOR_FLAGS, ...GATE_FLAGS, ...BATCH_FLAGS, "checkpoint", "db", "minimum-savings-bytes", "report"],
    run: (f) => compactHistoricalIssueLogPayloads({
      actor: optionalActor(f), ...gate(f), ...batch(f),
      checkpointPath: required(f, "checkpoint"),
      dbPath: required(f, "db"),
      minimumSavingsBytes: optionalNonNegativeInteger(f["minimum-savings-bytes"], "--minimum-savings-bytes"),
      reportPath: required(f, "report")
    })
  },
  "events restore-payloads": {
    flags: [...ACTOR_FLAGS, ...GATE_FLAGS, ...BATCH_FLAGS, "checkpoint", "compaction-checkpoint", "db", "report"],
    run: (f) => restoreHistoricalIssueLogPayloads({
      actor: optionalActor(f), ...gate(f), ...batch(f),
      checkpointPath: required(f, "checkpoint"),
      compactionCheckpointPath: required(f, "compaction-checkpoint"),
      dbPath: required(f, "db"),
      reportPath: required(f, "report")
    })
  },
  "events archive": {
    flags: [...ACTOR_FLAGS, ...BATCH_FLAGS, "archive", "before", "db", "now", "report"],
    run: (f) => archiveEventMaintenance({
      actor: actor(f), ...batch(f),
      archiveDir: required(f, "archive"),
      before: f.before,
      dbPath: required(f, "db"),
      now: f.now,
      reportPath: required(f, "report")
    })
  },
  "events delete": {
    flags: [...GATE_FLAGS, ...BATCH_FLAGS, "archive", "checkpoint", "db", "evidence", "now", "report"],
    run: (f) => deleteArchivedEvents({
      ...gate(f), ...batch(f),
      archiveDir: required(f, "archive"),
      checkpointPath: required(f, "checkpoint"),
      dbPath: required(f, "db"),
      evidencePath: required(f, "evidence"),
      now: f.now,
      reportPath: required(f, "report")
    })
  },
  "events prepare-delete-evidence": {
    flags: [...ATTRIBUTED_FLAGS, "archive", "backup", "correlation-id", "db", "holds", "now", "output"],
    run: (f) => prepareEventDeleteEvidence({
      actor: { ...actor(f), actorKind: actorKind(f["actor-kind"]) },
      archiveDir: required(f, "archive"),
      backupDbPath: required(f, "backup"),
      correlationID: required(f, "correlation-id"),
      dbPath: required(f, "db"),
      holdsPath: f.holds,
      now: f.now,
      outputPath: required(f, "output")
    })
  },
  "events verify-archive": {
    flags: ["archive", "report", "sample-size"],
    run: (f) => verifyEventArchive({
      archiveDir: required(f, "archive"),
      reportPath: f.report,
      sampleSize: optionalInteger(f["sample-size"], "--sample-size")
    })
  },
  "events restore": {
    flags: [...ACTOR_FLAGS, ...GATE_FLAGS, ...BATCH_FLAGS, "archive", "checkpoint", "db", "report"],
    run: (f) => restoreArchivedEvents({
      actor: actor(f), ...gate(f), ...batch(f),
      archiveDir: required(f, "archive"),
      checkpointPath: required(f, "checkpoint"),
      dbPath: required(f, "db"),
      reportPath: required(f, "report")
    })
  },
  "db checkpoint": {
    flags: [...ACTOR_FLAGS, ...GATE_FLAGS, "db", "mode", "report"],
    run: (f) => checkpointEventDatabase({
      actor: actor(f), ...gate(f),
      dbPath: required(f, "db"),
      mode: oneOf(f.mode?.trim().toLowerCase() || "passive", ["passive", "full", "restart", "truncate"], "--mode"),
      reportPath: required(f, "report")
    })
  },
  "db vacuum": {
    flags: [...ACTOR_FLAGS, ...GATE_FLAGS, "db", "enable-incremental", "mode", "pages", "report"],
    run: (f) => vacuumEventDatabase({
      actor: actor(f), ...gate(f),
      dbPath: required(f, "db"),
      enableIncremental: enabled(f, "enable-incremental"),
      mode: oneOf(f.mode?.trim().toLowerCase() || "full", ["full", "incremental"], "--mode"),
      pages: optionalInteger(f.pages, "--pages"),
      reportPath: required(f, "report")
    })
  },
  "db wal": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "db", "operation", "report"],
    run: (f) => runWalMaintenance({
      ...optionalAttribution(f), ...gate(f),
      dbPath: required(f, "db"),
      operation: oneOf(required(f, "operation"), ["apply", "dry-run", "rollback", "verify"], "--operation"),
      reportPath: required(f, "report")
    })
  },
  "db migration-preflight": {
    flags: ["compat-version", "db", "report"],
    run: (f) => preflightDatabaseMigration({
      compatVersion: f["compat-version"], dbPath: required(f, "db"), reportPath: required(f, "report")
    })
  },
  "db migration-forward": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "backup", "compat-version", "db", "report"],
    run: (f) => forwardDatabaseMigration(migrationInput(f))
  },
  "db migration-rollback": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "backup", "compat-version", "db", "report"],
    run: (f) => rollbackDatabaseMigration(migrationInput(f))
  },
  "db legacy-automation-drop": {
    flags: [...ATTRIBUTED_FLAGS, ...GATE_FLAGS, "archive", "backup", "confirm-tables", "db", "release-ref", "report", "source-root"],
    run: (f) => cleanupLegacyAutomationSchema({
      ...optionalAttribution(f), ...gate(f),
      archivePath: f.archive,
      backupPath: f.backup,
      confirmTables: f["confirm-tables"],
      dbPath: required(f, "db"),
      releaseRef: f["release-ref"],
      reportPath: required(f, "report"),
      sourceRoot: f["source-root"]
    })
  },
  "db legacy-automation-archive-verify": {
    flags: ["archive"],
    run: (f) => verifyLegacyAutomationArchive(required(f, "archive"))
  },
  "attention audit": {
    flags: ["db", "report"],
    run: (f) => auditPiDecisionConsolidation({ dbPath: required(f, "db"), reportPath: required(f, "report") })
  }
};
