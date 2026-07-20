import {
  archiveEventMaintenance,
  checkpointEventDatabase,
  deleteArchivedEvents,
  previewEventMaintenance,
  restoreArchivedEvents,
  vacuumEventDatabase
} from "../events/maintenanceService.ts";
import { rebuildEventSummaryProjection } from "../events/eventSummaryProjectionService.ts";
import {
  cutoverCompactEventSummaryProjection,
  observeCompactEventSummaryProjection,
  rebuildCompactEventSummaryProjection,
  rollbackCompactEventSummaryProjection,
  verifyCompactEventSummaryProjection
} from "../events/compactEventSummaryProjectionService.ts";
import {
  compactHistoricalIssueLogPayloads,
  restoreHistoricalIssueLogPayloads
} from "../events/payloadCompactionService.ts";
import {
  auditWorkConsistency,
  backfillIssueWorks,
  rollbackIssueWorkBackfill
} from "../domain/work/migrationService.ts";
import { auditPiDecisionConsolidation } from "../domain/attention/consolidationAudit.ts";
import {
  forwardDatabaseMigration,
  preflightDatabaseMigration,
  rollbackDatabaseMigration
} from "../db/migrationRehearsal.ts";
import {
  cleanupLegacyAutomationSchema,
  verifyLegacyAutomationArchive
} from "../db/legacyAutomationCleanup.ts";
import { formatJSON } from "./output.ts";

const BOOLEAN_FLAGS = new Set([
  "apply",
  "confirm-backup-tested",
  "confirm-no-active-writers",
  "enable-incremental",
  "json",
  "resume"
]);

export function runMaintenance(args: string[]): string {
  const family = args[0]?.trim();
  const command = args[1]?.trim();
  if (!family || !command) throw new Error("usage: maintenance <events|db|work|attention> <command> [flags]");
  const flags = parseFlags(args.slice(2));
  let report: Record<string, unknown>;
  if (family === "events" && command === "report") {
    allowOnly(flags, ["before", "db", "json", "now", "report"]);
    report = previewEventMaintenance({
      dbPath: required(flags, "db"),
      before: flags.before,
      now: flags.now,
      reportPath: flags.report
    });
  } else if (family === "events" && command === "rebuild-projection") {
    allowOnly(flags, ["actor", "actor-kind", "audit-ref", "batch-size", "db", "json", "max-batches", "reason", "resume"]);
    report = rebuildEventSummaryProjection({
      actor: required(flags, "actor"),
      actorKind: actorKind(flags["actor-kind"]),
      auditRef: required(flags, "audit-ref"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reason: required(flags, "reason"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "rebuild-compact-projection") {
    allowOnly(flags, ["actor", "actor-kind", "audit-ref", "batch-size", "db", "json", "max-batches", "reason", "resume"]);
    report = rebuildCompactEventSummaryProjection({
      actor: required(flags, "actor"),
      actorKind: actorKind(flags["actor-kind"]),
      auditRef: required(flags, "audit-ref"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reason: required(flags, "reason"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "verify-compact-projection") {
    allowOnly(flags, ["db", "json", "performance-samples"]);
    report = verifyCompactEventSummaryProjection({
      dbPath: required(flags, "db"),
      performanceSamples: optionalInteger(flags["performance-samples"], "--performance-samples")
    });
  } else if (family === "events" && command === "observe-compact-projection") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "confirm-backup-tested",
      "confirm-no-active-writers", "db", "duration-seconds", "json", "reason"
    ]);
    report = observeCompactEventSummaryProjection({
      actor: required(flags, "actor"),
      actorKind: actorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: required(flags, "audit-ref"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      durationSeconds: optionalNonNegativeInteger(flags["duration-seconds"], "--duration-seconds"),
      reason: required(flags, "reason")
    });
  } else if (family === "events" && command === "cutover-compact-projection") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "confirm-backup-tested",
      "confirm-no-active-writers", "db", "json", "minimum-observation-seconds", "reason"
    ]);
    report = cutoverCompactEventSummaryProjection({
      actor: required(flags, "actor"),
      actorKind: actorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: required(flags, "audit-ref"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      minimumObservationSeconds: optionalNonNegativeInteger(flags["minimum-observation-seconds"], "--minimum-observation-seconds"),
      reason: required(flags, "reason")
    });
  } else if (family === "events" && command === "rollback-compact-projection") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "confirm-backup-tested",
      "confirm-no-active-writers", "db", "json", "reason"
    ]);
    report = rollbackCompactEventSummaryProjection({
      actor: required(flags, "actor"),
      actorKind: actorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: required(flags, "audit-ref"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      reason: required(flags, "reason")
    });
  } else if (family === "events" && command === "compact-payloads") {
    allowOnly(flags, [
      "actor", "apply", "audit-ref", "batch-size", "checkpoint",
      "confirm-backup-tested", "confirm-no-active-writers", "db", "json",
      "max-batches", "minimum-savings-bytes", "reason", "report", "resume"
    ]);
    report = compactHistoricalIssueLogPayloads({
      actor: optionalActor(flags),
      apply: enabled(flags, "apply"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      minimumSavingsBytes: optionalNonNegativeInteger(flags["minimum-savings-bytes"], "--minimum-savings-bytes"),
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "restore-payloads") {
    allowOnly(flags, [
      "actor", "apply", "audit-ref", "batch-size", "checkpoint", "compaction-checkpoint",
      "confirm-backup-tested", "confirm-no-active-writers", "db", "json",
      "max-batches", "reason", "report", "resume"
    ]);
    report = restoreHistoricalIssueLogPayloads({
      actor: optionalActor(flags),
      apply: enabled(flags, "apply"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      compactionCheckpointPath: required(flags, "compaction-checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "archive") {
    allowOnly(flags, ["actor", "archive", "audit-ref", "batch-size", "before", "db", "json", "max-batches", "now", "reason", "report", "resume"]);
    report = archiveEventMaintenance({
      actor: actor(flags),
      archiveDir: required(flags, "archive"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      before: flags.before,
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      now: flags.now,
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "delete") {
    allowOnly(flags, ["apply", "archive", "batch-size", "checkpoint", "confirm-backup-tested", "confirm-no-active-writers", "db", "evidence", "json", "max-batches", "now", "report", "resume"]);
    report = deleteArchivedEvents({
      apply: enabled(flags, "apply"),
      archiveDir: required(flags, "archive"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      evidencePath: required(flags, "evidence"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      now: flags.now,
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "events" && command === "restore") {
    allowOnly(flags, ["actor", "apply", "archive", "audit-ref", "batch-size", "checkpoint", "confirm-backup-tested", "confirm-no-active-writers", "db", "json", "max-batches", "reason", "report", "resume"]);
    report = restoreArchivedEvents({
      actor: actor(flags),
      apply: enabled(flags, "apply"),
      archiveDir: required(flags, "archive"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "db" && command === "checkpoint") {
    allowOnly(flags, ["actor", "apply", "audit-ref", "confirm-backup-tested", "confirm-no-active-writers", "db", "json", "mode", "reason", "report"]);
    report = checkpointEventDatabase({
      actor: actor(flags),
      apply: enabled(flags, "apply"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      mode: checkpointMode(flags.mode),
      reportPath: required(flags, "report")
    });
  } else if (family === "db" && command === "vacuum") {
    allowOnly(flags, ["actor", "apply", "audit-ref", "confirm-backup-tested", "confirm-no-active-writers", "db", "enable-incremental", "json", "mode", "pages", "reason", "report"]);
    report = vacuumEventDatabase({
      actor: actor(flags),
      apply: enabled(flags, "apply"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      enableIncremental: enabled(flags, "enable-incremental"),
      mode: vacuumMode(flags.mode),
      pages: optionalInteger(flags.pages, "--pages"),
      reportPath: required(flags, "report")
    });
  } else if (family === "db" && command === "migration-preflight") {
    allowOnly(flags, ["compat-version", "db", "json", "report"]);
    report = preflightDatabaseMigration({
      compatVersion: flags["compat-version"],
      dbPath: required(flags, "db"),
      reportPath: required(flags, "report")
    });
  } else if (family === "db" && command === "migration-forward") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "backup", "compat-version",
      "confirm-backup-tested", "confirm-no-active-writers", "db", "json", "reason", "report"
    ]);
    report = forwardDatabaseMigration({
      actor: flags.actor,
      actorKind: workActorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: flags["audit-ref"],
      backupPath: flags.backup,
      compatVersion: flags["compat-version"],
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      reason: flags.reason,
      reportPath: required(flags, "report")
    });
  } else if (family === "db" && command === "migration-rollback") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "backup", "compat-version",
      "confirm-backup-tested", "confirm-no-active-writers", "db", "json", "reason", "report"
    ]);
    report = rollbackDatabaseMigration({
      actor: flags.actor,
      actorKind: workActorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: flags["audit-ref"],
      backupPath: flags.backup,
      compatVersion: flags["compat-version"],
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      reason: flags.reason,
      reportPath: required(flags, "report")
    });
  } else if (family === "db" && command === "legacy-automation-drop") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "archive", "audit-ref", "backup",
      "confirm-backup-tested", "confirm-no-active-writers", "confirm-tables",
      "db", "json", "reason", "release-ref", "report", "source-root"
    ]);
    report = cleanupLegacyAutomationSchema({
      actor: flags.actor,
      actorKind: workActorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      archivePath: flags.archive,
      auditRef: flags["audit-ref"],
      backupPath: flags.backup,
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      confirmTables: flags["confirm-tables"],
      dbPath: required(flags, "db"),
      reason: flags.reason,
      releaseRef: flags["release-ref"],
      reportPath: required(flags, "report"),
      sourceRoot: flags["source-root"]
    });
  } else if (family === "db" && command === "legacy-automation-archive-verify") {
    allowOnly(flags, ["archive", "json"]);
    report = verifyLegacyAutomationArchive(required(flags, "archive"));
  } else if (family === "attention" && command === "audit") {
    allowOnly(flags, ["db", "json", "report"]);
    report = auditPiDecisionConsolidation({
      dbPath: required(flags, "db"),
      reportPath: required(flags, "report")
    });
  } else if (family === "work" && command === "audit") {
    allowOnly(flags, ["db", "json", "report"]);
    report = auditWorkConsistency({
      dbPath: required(flags, "db"),
      reportPath: required(flags, "report")
    });
  } else if (family === "work" && command === "backfill") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "batch-size", "checkpoint",
      "confirm-backup-tested", "confirm-no-active-writers", "db", "json", "max-batches",
      "reason", "report", "resume"
    ]);
    report = backfillIssueWorks({
      actor: flags.actor,
      actorKind: workActorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: flags["audit-ref"],
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reason: flags.reason,
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else if (family === "work" && command === "rollback") {
    allowOnly(flags, [
      "actor", "actor-kind", "apply", "audit-ref", "backfill-checkpoint", "batch-size",
      "checkpoint", "confirm-backup-tested", "confirm-no-active-writers", "db", "json",
      "max-batches", "reason", "report", "resume"
    ]);
    report = rollbackIssueWorkBackfill({
      actor: flags.actor,
      actorKind: workActorKind(flags["actor-kind"]),
      apply: enabled(flags, "apply"),
      auditRef: flags["audit-ref"],
      backfillCheckpointPath: required(flags, "backfill-checkpoint"),
      batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
      checkpointPath: required(flags, "checkpoint"),
      confirmBackupTested: enabled(flags, "confirm-backup-tested"),
      confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers"),
      dbPath: required(flags, "db"),
      maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
      reason: flags.reason,
      reportPath: required(flags, "report"),
      resume: enabled(flags, "resume")
    });
  } else {
    throw new Error(`unknown maintenance command: ${family} ${command}`);
  }
  return enabled(flags, "json") ? formatJSON(report) : humanSummary(report, flags.report);
}

function allowOnly(flags: Record<string, string>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).find((name) => !allowedSet.has(name));
  if (unknown) throw new Error(`Unknown argument: --${unknown}`);
}

function parseFlags(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    if (!name) throw new Error(`Unknown argument: ${argument}`);
    if (name in values) throw new Error(`duplicate flag: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (separator >= 0) throw new Error(`--${name} does not take a value`);
      values[name] = "true";
      continue;
    }
    const value = separator >= 0 ? argument.slice(separator + 1) : args[index + 1];
    if (!value || (separator < 0 && value.startsWith("--"))) throw new Error(`Missing value for --${name}`);
    values[name] = value;
    if (separator < 0) index += 1;
  }
  return values;
}

function actor(flags: Record<string, string>): { actor: string; auditRef: string; reason: string } {
  return {
    actor: required(flags, "actor"),
    auditRef: required(flags, "audit-ref"),
    reason: required(flags, "reason")
  };
}

function optionalActor(flags: Record<string, string>): { actor: string; auditRef: string; reason: string } | undefined {
  if (!flags.actor && !flags["audit-ref"] && !flags.reason) return undefined;
  return actor(flags);
}

function actorKind(value: string | undefined): "retention_worker" | "system" | "user" {
  const kind = value?.trim().toLowerCase();
  if (kind === "retention_worker" || kind === "system" || kind === "user") return kind;
  throw new Error("--actor-kind must be user, system, or retention_worker");
}

function workActorKind(value: string | undefined): "automation" | "system" | "user" | undefined {
  if (value === undefined) return undefined;
  const kind = value.trim().toLowerCase();
  if (kind === "automation" || kind === "system" || kind === "user") return kind;
  throw new Error("--actor-kind must be user, system, or automation");
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim() ?? "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function enabled(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

function optionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function checkpointMode(value: string | undefined): "passive" | "full" | "restart" | "truncate" {
  const mode = value?.trim().toLowerCase() || "passive";
  if (mode === "passive" || mode === "full" || mode === "restart" || mode === "truncate") return mode;
  throw new Error("--mode must be passive, full, restart, or truncate");
}

function vacuumMode(value: string | undefined): "full" | "incremental" {
  const mode = value?.trim().toLowerCase() || "full";
  if (mode === "full" || mode === "incremental") return mode;
  throw new Error("--mode must be full or incremental");
}

function humanSummary(report: Record<string, unknown>, reportPath: string | undefined): string {
  const operation = String(report.operation ?? "maintenance");
  const dryRun = Boolean(report.dry_run);
  const paused = Boolean(report.paused);
  return `${operation} dry_run=${dryRun} paused=${paused}${reportPath ? ` report=${reportPath}` : ""}\n`;
}
