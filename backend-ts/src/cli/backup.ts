import { readFileSync } from "node:fs";
import { buildRunnerPaths } from "../config/paths.ts";
import { exportBackup, importBackup, verifyBackup } from "../backup/service.ts";
import { parseCommonArgs } from "./common.ts";
import { formatJSON } from "./output.ts";
import type { EnvReader } from "./types.ts";

const BOOLEAN_FLAGS = new Set(["apply", "encrypt"]);

export async function runBackup(args: string[], env: EnvReader): Promise<string> {
  const command = args[0]?.trim();
  if (command !== "export" && command !== "import" && command !== "verify") {
    throw new Error("usage: backup <export|import|verify> [flags]");
  }
  const common = parseCommonArgs(args.slice(1), env);
  const flags = parseFlags(common.rest);
  const paths = buildRunnerPaths({ dbPath: flags.db, stateDir: flags["state-dir"] });
  const result = command === "export"
    ? await exportBackup({
      ...actor(flags),
      dbPath: paths.dbPath,
      encrypt: enabled(flags, "encrypt"),
      outputPath: required(flags, "output"),
      passphrase: passphrase(flags),
      retain: optionalPositiveInteger(flags.retain, "--retain"),
      stateDir: paths.stateDir
    })
    : command === "import"
      ? await importBackup({
        ...actor(flags),
        apply: enabled(flags, "apply"),
        inputPath: required(flags, "input"),
        passphrase: passphrase(flags),
        targetStateDir: required(flags, "target-state-dir")
      })
      : await verifyBackup({ inputPath: required(flags, "input"), passphrase: passphrase(flags) });
  return common.flags.json ? formatJSON(result) : `${String(result.action)} verified=${String(result.verified)}\n`;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const equal = argument.indexOf("=");
    const name = argument.slice(2, equal < 0 ? undefined : equal);
    if (!name || name in flags) throw new Error(`duplicate or invalid flag: ${argument}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new Error(`--${name} does not take a value`);
      flags[name] = "true";
      continue;
    }
    const value = equal >= 0 ? argument.slice(equal + 1) : args[index + 1];
    if (!value || (equal < 0 && value.startsWith("--"))) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
    if (equal < 0) index += 1;
  }
  return flags;
}

function actor(flags: Record<string, string>) {
  return {
    actor: required(flags, "actor"),
    actorKind: actorKind(required(flags, "actor-kind")),
    auditRef: required(flags, "audit-ref"),
    reason: required(flags, "reason")
  };
}

function actorKind(value: string): "automation" | "system" | "user" {
  if (value === "automation" || value === "system" || value === "user") return value;
  throw new Error("--actor-kind must be user, system, or automation");
}

function passphrase(flags: Record<string, string>): string | undefined {
  const file = flags["passphrase-file"];
  if (!file) return undefined;
  try {
    const passphrase = readFileSync(file, "utf8").trim();
    if (!passphrase) throw new Error("empty");
    return passphrase;
  } catch {
    throw new Error("--passphrase-file must point to a non-empty readable file");
  }
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function enabled(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim() ?? "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
