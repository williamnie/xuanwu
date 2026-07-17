import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openDatabase } from "../db/database.ts";
import type { SecretBackendID } from "../security/secrets/contracts.ts";
import { migrateLegacySecretConfigs, scanHistoricalSecretPayloads } from "../security/secrets/migration.ts";
import { createDatabaseSecretService, createSecretService } from "../security/secrets/service.ts";
import { formatJSON } from "./output.ts";
import type { EnvReader } from "./types.ts";

const BOOLEAN_FLAGS = new Set(["apply", "json"]);

export async function runSecrets(args: string[], env: EnvReader): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("usage: secrets <put|rotate|revoke|status|scan|migrate> [flags]");
  const flags = parseFlags(args.slice(1));
  const backend = secretBackend(flags.backend);
  const dbPath = flags.db?.trim() || env("CODEX_RUNNER_DB")?.trim() || "";
  const stateDir = flags["state-dir"]?.trim() || env("CODEX_RUNNER_STATE_DIR")?.trim() || (dbPath ? dirname(dbPath) : "");
  if (!stateDir) throw new Error("--state-dir is required");

  if (command === "status") {
    allowOnly(flags, ["backend", "json", "ref", "state-dir"]);
    const metadata = createSecretService({ backend, stateDir }).describe(required(flags, "ref"));
    if (!metadata) throw new Error("secret_not_found: secret is not configured");
    return output(metadata, enabled(flags, "json"));
  }
  if (command === "scan") {
    allowOnly(flags, ["db", "json", "state-dir"]);
    if (!dbPath) throw new Error("--db is required");
    return output(scanHistoricalSecretPayloads({ dbPath, stateDir }), enabled(flags, "json"));
  }
  if (command === "migrate") {
    allowOnly(flags, ["actor", "apply", "backend", "db", "json", "reason", "state-dir"]);
    if (!enabled(flags, "apply")) {
      return output(migrateLegacySecretConfigs({
        actor: flags.actor ?? "dry-run",
        apply: false,
        reason: flags.reason ?? "dry-run",
        secrets: createSecretService({ backend, stateDir }),
        stateDir
      }), enabled(flags, "json"));
    }
    if (!dbPath) throw new Error("--db is required when --apply is set");
    const database = await openDatabase({ dbPath, stateDir });
    try {
      return output(migrateLegacySecretConfigs({
        actor: required(flags, "actor"),
        apply: true,
        reason: required(flags, "reason"),
        secrets: createDatabaseSecretService(database, { backend, stateDir }),
        stateDir
      }), enabled(flags, "json"));
    } finally {
      database.close();
    }
  }

  if (!dbPath) throw new Error("--db is required for secret mutations");
  const database = await openDatabase({ dbPath, stateDir });
  try {
    const secrets = createDatabaseSecretService(database, { backend, stateDir });
    if (command === "put") {
      allowOnly(flags, ["actor", "backend", "db", "json", "name", "reason", "state-dir", "value-file"]);
      const metadata = secrets.put(
        required(flags, "name"),
        await secretValue(required(flags, "value-file")),
        required(flags, "actor"),
        required(flags, "reason")
      );
      return output(metadata, enabled(flags, "json"));
    }
    if (command === "rotate") {
      allowOnly(flags, ["actor", "backend", "db", "json", "reason", "ref", "state-dir", "value-file"]);
      const metadata = secrets.rotate(
        required(flags, "ref"),
        await secretValue(required(flags, "value-file")),
        required(flags, "actor"),
        required(flags, "reason")
      );
      return output(metadata, enabled(flags, "json"));
    }
    if (command === "revoke") {
      allowOnly(flags, ["actor", "backend", "db", "json", "reason", "ref", "state-dir"]);
      return output(secrets.revoke(
        required(flags, "ref"),
        required(flags, "actor"),
        required(flags, "reason")
      ), enabled(flags, "json"));
    }
    throw new Error(`unknown secrets command: ${command}`);
  } finally {
    database.close();
  }
}

async function secretValue(path: string): Promise<string> {
  const value = path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8");
  return value.replace(/\r?\n$/, "");
}

function output(value: unknown, json: boolean): string {
  if (json) return formatJSON(value);
  const record = value as { ref?: string; status?: string; version?: number };
  return record.ref ? `${record.ref} status=${record.status ?? "unknown"} version=${record.version ?? 0}\n` : `${JSON.stringify(value)}\n`;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    if (!name || name in flags) throw new Error(`duplicate or invalid flag: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (separator >= 0) throw new Error(`--${name} does not take a value`);
      flags[name] = "true";
      continue;
    }
    const value = separator >= 0 ? argument.slice(separator + 1) : args[index + 1];
    if (!value || (separator < 0 && value.startsWith("--"))) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
    if (separator < 0) index += 1;
  }
  return flags;
}

function allowOnly(flags: Record<string, string>, allowed: string[]): void {
  const names = new Set(allowed);
  const unknown = Object.keys(flags).find((name) => !names.has(name));
  if (unknown) throw new Error(`Unknown argument: --${unknown}`);
}

function required(flags: Record<string, string>, key: string): string {
  const value = flags[key]?.trim() ?? "";
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function enabled(flags: Record<string, string>, key: string): boolean {
  return flags[key] === "true";
}

function secretBackend(value: string | undefined): SecretBackendID | undefined {
  const backend = value?.trim();
  if (!backend) return undefined;
  if (backend === "file" || backend === "keychain") return backend;
  throw new Error("--backend must be file or keychain");
}
