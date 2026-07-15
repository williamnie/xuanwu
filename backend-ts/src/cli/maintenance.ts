import {
  archiveEventMaintenance,
  checkpointEventDatabase,
  deleteArchivedEvents,
  previewEventMaintenance,
  restoreArchivedEvents,
  vacuumEventDatabase
} from "../events/maintenanceService.ts";
import { rebuildEventSummaryProjection } from "../events/eventSummaryProjectionService.ts";
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
  if (!family || !command) throw new Error("usage: maintenance <events|db> <command> [flags]");
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

function actorKind(value: string | undefined): "retention_worker" | "system" | "user" {
  const kind = value?.trim().toLowerCase();
  if (kind === "retention_worker" || kind === "system" || kind === "user") return kind;
  throw new Error("--actor-kind must be user, system, or retention_worker");
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
