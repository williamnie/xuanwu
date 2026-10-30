import type { Flags } from "./maintenance.model.ts";

export const BOOLEAN_FLAGS = new Set([
  "apply",
  "confirm-backup-tested",
  "confirm-no-active-writers",
  "enable-incremental",
  "json",
  "resume"
]);

// Flag groups shared by the guarded (dry-run by default) operations.
export const GATE_FLAGS = ["apply", "confirm-backup-tested", "confirm-no-active-writers"];

export const ACTOR_FLAGS = ["actor", "audit-ref", "reason"];

export const ATTRIBUTED_FLAGS = [...ACTOR_FLAGS, "actor-kind"];

export const BATCH_FLAGS = ["batch-size", "max-batches", "resume"];

export function parseFlags(args: string[]): Flags {
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

export function actor(flags: Flags): { actor: string; auditRef: string; reason: string } {
  return { actor: required(flags, "actor"), auditRef: required(flags, "audit-ref"), reason: required(flags, "reason") };
}

export function optionalActor(flags: Flags): ReturnType<typeof actor> | undefined {
  return flags.actor || flags["audit-ref"] || flags.reason ? actor(flags) : undefined;
}

/** Required actor fields for event projection operations, with a retention-worker capable kind. */
export function attributedActor(flags: Flags) {
  return { ...actor(flags), actorKind: actorKind(flags["actor-kind"]) };
}

/** Optional actor fields; the operation itself rejects an apply without them. */
export function optionalAttribution(flags: Flags) {
  const kind = flags["actor-kind"];
  return {
    actor: flags.actor,
    actorKind: kind === undefined ? undefined : oneOf(kind.trim().toLowerCase(), ["automation", "system", "user"], "--actor-kind"),
    auditRef: flags["audit-ref"],
    reason: flags.reason
  };
}

export function migrationInput(flags: Flags) {
  return {
    ...optionalAttribution(flags), ...gate(flags),
    backupPath: flags.backup,
    compatVersion: flags["compat-version"],
    dbPath: required(flags, "db"),
    reportPath: required(flags, "report")
  };
}

export function gate(flags: Flags) {
  return {
    apply: enabled(flags, "apply"),
    confirmBackupTested: enabled(flags, "confirm-backup-tested"),
    confirmNoActiveWriters: enabled(flags, "confirm-no-active-writers")
  };
}

export function batch(flags: Flags) {
  return {
    batchSize: optionalInteger(flags["batch-size"], "--batch-size"),
    maxBatches: optionalInteger(flags["max-batches"], "--max-batches"),
    resume: enabled(flags, "resume")
  };
}

export function actorKind(value: string | undefined): "retention_worker" | "system" | "user" {
  return oneOf(value?.trim().toLowerCase() ?? "", ["retention_worker", "system", "user"], "--actor-kind");
}

export function oneOf<const T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

export function required(flags: Flags, name: string): string {
  const value = flags[name]?.trim() ?? "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function enabled(flags: Flags, name: string): boolean {
  return flags[name] === "true";
}

export function optionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function optionalNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}
