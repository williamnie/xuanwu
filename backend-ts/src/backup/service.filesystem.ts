import { readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import type { Manifest, SnapshotEntry } from "./service.model.ts";
import { scalar, sha256 } from "./service.validation.ts";

export function snapshotDatabase(source: string, target: string): Manifest["database"] {
  const sqlite = new Database(source, { readonly: false, strict: true });
  try {
    sqlite.run("vacuum main into ?", [target]);
  } finally {
    sqlite.close();
  }
  const copy = new Database(target, { readonly: true, strict: true });
  try {
    const quickCheck = scalar(copy, "pragma quick_check");
    if (quickCheck !== "ok") throw new Error(`database snapshot quick_check failed: ${quickCheck}`);
    return {
      path: "database/runner.db",
      quick_check: quickCheck,
      schema_migrations: copy.query<{ id: string }, []>("select id from schema_migrations order by id").all().map((row) => row.id)
    };
  } finally {
    copy.close();
  }
}

export async function retentionPlan(parent: string, retain: number | undefined, current: string): Promise<string[]> {
  if (retain === undefined) return [];
  if (!Number.isSafeInteger(retain) || retain < 1) throw new Error("--retain must be a positive integer");
  const candidates = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith("xuanwu-backup-"))
    .map((entry) => join(parent, entry.name));
  if (basename(current).startsWith("xuanwu-backup-")) candidates.push(current);
  candidates.sort((left, right) => right.localeCompare(left));
  const retained = new Set(candidates.slice(0, retain));
  return candidates.filter((candidate) => candidate !== current && !retained.has(candidate));
}

export async function applyRetention(paths: string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

export async function entryFor(root: string, path: string): Promise<SnapshotEntry> {
  const body = await readFile(join(root, path));
  return { bytes: body.byteLength, path, sha256: sha256(body) };
}

export async function* walkStateFiles(root: string): AsyncGenerator<string> {
  for await (const file of walkFiles(root)) yield file;
}

export async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${path}`);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

export function restorePath(root: string, path: string): string {
  if (path === "database/runner.db") return join(root, "runner.db");
  if (!path.startsWith("state/")) throw new Error(`backup payload path is not restorable: ${path}`);
  const destination = resolve(root, path.slice("state/".length));
  if (!destination.startsWith(`${resolve(root)}${sep}`)) throw new Error("backup payload path escapes restore state directory");
  return destination;
}
