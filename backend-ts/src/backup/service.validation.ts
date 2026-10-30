import { createHash, scryptSync } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { SNAPSHOT_SCHEMA } from "./service.model.ts";
import type { Manifest, Actor } from "./service.model.ts";

export function validateManifest(manifest: Manifest): void {
  if (!manifest || manifest.schema_version !== SNAPSHOT_SCHEMA || !Array.isArray(manifest.files) || !manifest.database) {
    throw new Error("unsupported backup manifest");
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || !safePayloadPath(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("backup manifest has an invalid payload entry");
    }
    seen.add(entry.path);
  }
  if (!seen.has(manifest.database.path)) throw new Error("backup manifest database path is missing");
}

export function safePayloadPath(path: string): boolean {
  return (path === "database/runner.db" || path.startsWith("state/")) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function isSecretMaterialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === "auth_token" || name === "auth.json" || name === ".env" || /\.(?:key|pem)$/.test(name)) return true;
  // Secret references are configuration, not secret material, and must survive restore.
  return /(?:^|\/)[^/]*(?:secret|token|private)[^/]*(?:\/|$)/.test(path.toLowerCase()) &&
    !/(?:^|[-_./])ref(?:[-_./]|$)/.test(path.toLowerCase());
}

export function authorize(input: Actor): Actor {
  const actor = required(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  if (input.actorKind !== "automation" && input.actorKind !== "system" && input.actorKind !== "user") {
    throw new Error("--actor-kind must be user, system, or automation");
  }
  return { actor, actorKind: input.actorKind, auditRef: required(input.auditRef, "--audit-ref"), reason: required(input.reason, "--reason") };
}

export function resolveRequired(value: string, name: string): string {
  return resolve(required(value, name));
}

export function required(value: string | undefined, name: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

export function keyFor(passphrase: string, salt: string): Buffer {
  return scryptSync(passphrase, Buffer.from(salt, "base64"), 32);
}

export function scalar(database: Database, sql: string): string {
  const row = database.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
