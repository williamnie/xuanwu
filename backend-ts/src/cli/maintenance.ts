import { archiveEventMaintenance, previewEventMaintenance, verifyEventArchive } from "../events/maintenance/archive.ts";
import { checkpointEventDatabase, vacuumEventDatabase } from "../events/maintenance/database.ts";
import { deleteArchivedEvents, prepareEventDeleteEvidence, restoreArchivedEvents } from "../events/maintenance/deletion.ts";
import { rebuildEventSummaryProjection } from "../events/eventSummaryProjectionService.ts";
import {
  cutoverCompactEventSummaryProjection,
  observeCompactEventSummaryProjection,
  rebuildCompactEventSummaryProjection,
  retireLegacyEventSummaryProjection,
  rollbackCompactEventSummaryProjection,
  verifyCompactEventSummaryProjection
} from "../events/compactEventSummaryProjectionService.ts";
import {
  compactHistoricalIssueLogPayloads,
  restoreHistoricalIssueLogPayloads
} from "../events/payloadCompactionService.ts";
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
import { runWalMaintenance } from "../db/walMaintenance.ts";
import { formatJSON } from "./output.ts";

type Flags = Record<string, string>;
type Report = Record<string, unknown>;
type Command = { flags: string[]; run: (flags: Flags) => Report };

const BOOLEAN_FLAGS = new Set([
  "apply",
  "confirm-backup-tested",
  "confirm-no-active-writers",
  "enable-incremental",
  "json",
  "resume"
]);

// Flag groups shared by the guarded (dry-run by default) operations.
const GATE_FLAGS = ["apply", "confirm-backup-tested", "confirm-no-active-writers"];
const ACTOR_FLAGS = ["actor", "audit-ref", "reason"];
const ATTRIBUTED_FLAGS = [...ACTOR_FLAGS, "actor-kind"];
const BATCH_FLAGS = ["batch-size", "max-batches", "resume"];

const COMMANDS: Record<string, Command> = {
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

export function runMaintenance(args: string[]): string {
  const family = args[0]?.trim();
  const command = args[1]?.trim();
  if (!family || !command) throw new Error("usage: maintenance <events|db|attention> <command> [flags]");
  const flags = parseFlags(args.slice(2));
  const definition = COMMANDS[`${family} ${command}`];
  if (!definition) throw new Error(`unknown maintenance command: ${family} ${command}`);
  const allowed = new Set([...definition.flags, "json"]);
  const unknown = Object.keys(flags).find((name) => !allowed.has(name));
  if (unknown) throw new Error(`Unknown argument: --${unknown}`);
  const report = definition.run(flags);
  return enabled(flags, "json") ? formatJSON(report) : humanSummary(report, flags.report);
}

function parseFlags(args: string[]): Flags {
  const values: Flags = {};
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

function actor(flags: Flags): { actor: string; auditRef: string; reason: string } {
  return { actor: required(flags, "actor"), auditRef: required(flags, "audit-ref"), reason: required(flags, "reason") };
}

function optionalActor(flags: Flags): ReturnType<typeof actor> | undefined {
  return flags.actor || flags["audit-ref"] || flags.reason ? actor(flags) : undefined;
}

/** Required actor fields for event projection operations, with a retention-worker capable kind. */
function attributedActor(flags: Flags) {
  return { ...actor(flags), actorKind: actorKind(flags["actor-kind"]) };
}

/** Optional actor fields; the operation itself rejects an apply without them. */
function optionalAttribution(flags: Flags) {
  const kind = flags["actor-kind"];
  return {
    actor: flags.actor,
    actorKind: kind === undefined ? undefined : oneOf(kind.trim().toLowerCase(), ["automation", "system", "user"], "--actor-kind"),
    auditRef: flags["audit-ref"],
    reason: flags.reason
  };
}

function migrationInput(flags: Flags) {
  return {
    ...optionalAttribution(flags), ...gate(flags),
    backupPath: flags.backup,
    compatVersion: flags["compat-version"],
    dbPath: required(flags, "db"),
    reportPath: required(flags, "report")
  };
}

function gate(flags: Flags) {
  return {
    apply: enabled(flags, "apply"),
    confirmBackupTested: enabled(flags, "confirm-backup-tested"),
    confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers")
  };
}

function batch(flags: Flags) {
  return {
    batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
    maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
    resume: enabled(flags, "resume")
  };
}

function actorKind(value: string | undefined): "retention_worker" | "system" | "user" {
  return oneOf(value?.trim().toLowerCase() ?? "", ["retention_worker", "system", "user"], "--actor-kind");
}

function oneOf<const T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

function required(flags: Flags, name: string): string {
  const value = flags[name]?.trim() ?? "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function enabled(flags: Flags, name: string): boolean {
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

function humanSummary(report: Report, reportPath: string | undefined): string {
  const operation = String(report.operation ?? "maintenance");
  return `${operation} dry_run=${Boolean(report.dry_run)} paused=${Boolean(report.paused)}${reportPath ? ` report=${reportPath}` : ""}\n`;
}
