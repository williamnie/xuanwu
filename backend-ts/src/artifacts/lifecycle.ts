import { createHash, randomUUID } from "node:crypto";
import {
  copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, statfs, writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const ARTIFACT_LIFECYCLE_CONTRACT = "xw.artifact-lifecycle.v1" as const;
export const APPLICATION_SUPPORT_TARGET_BYTES = 3 * 1024 * 1024 * 1024;
export const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

type Actor = { actor: string; auditRef: string; reason: string };
type ArtifactDisposition = "archive" | "keep";
type ArtifactKind =
  | "authority_database"
  | "database_backup"
  | "evidence_manifest"
  | "evidence_snapshot"
  | "issue_log"
  | "migration_manifest"
  | "migration_snapshot"
  | "runtime_artifact"
  | "runtime_binary"
  | "runtime_secret";

export type ArtifactInventoryEntry = {
  active_runtime_reference: boolean;
  authority: "authority" | "derived" | "secret";
  bytes: number;
  created_at: string;
  disposition: ArtifactDisposition;
  generator: string;
  hash_status: "active_mutable" | "redacted" | "sha256";
  kind: ArtifactKind;
  last_verified_at: string | null;
  owner: string;
  path: string;
  restore_value: "critical" | "operational" | "reproducible" | "secret_reinject";
  retention_class: string;
  sha256: string | null;
};

export type ArtifactLifecycleManifest = {
  action: "artifact-lifecycle.apply" | "artifact-lifecycle.report";
  application_support: {
    after_bytes: number | null;
    before_bytes: number;
    target_bytes: number;
    target_status: "passed" | "pending_apply" | "failed";
  };
  archive_root: string;
  audit: (Actor & { applied_at: string }) | null;
  capacity: {
    available_bytes: number;
    candidate_bytes: number;
    minimum_free_bytes: number;
    preflight_required_bytes: number;
    status: "passed" | "failed";
  };
  contract: typeof ARTIFACT_LIFECYCLE_CONTRACT;
  created_at: string;
  dry_run: boolean;
  inventory: ArtifactInventoryEntry[];
  manifest_id: string;
  moved: Array<{ bytes: number; object_path: string; path: string; sha256: string }>;
  orphan_temporary_files: string[];
  policy: ReturnType<typeof lifecyclePolicy>;
  root: string;
  summary: {
    archive_bytes: number;
    archive_files: number;
    inventory_bytes: number;
    inventory_files: number;
    keep_bytes: number;
    keep_files: number;
  };
};

export type ArtifactLifecycleInput = {
  actor?: Actor;
  apply?: boolean;
  archiveRoot: string;
  confirmConsumerZero?: boolean;
  confirmRestoreTested?: boolean;
  minimumFreeBytes?: number;
  now?: Date;
  reportPath: string;
  root: string;
};

export type ArtifactRestoreInput = Actor & {
  apply?: boolean;
  manifestPath: string;
  reportPath: string;
  root: string;
};

export async function runArtifactLifecycle(input: ArtifactLifecycleInput): Promise<ArtifactLifecycleManifest> {
  const root = resolve(input.root);
  const archiveRoot = resolve(input.archiveRoot);
  const reportPath = resolve(input.reportPath);
  if (archiveRoot === root || archiveRoot.startsWith(`${root}${sep}`)) {
    throw new Error("--archive-root must be outside the live Application Support root");
  }
  if (!(await stat(root)).isDirectory()) throw new Error(`Application Support root does not exist: ${root}`);
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  const now = input.now ?? new Date();
  const inventory = await buildInventory(root, now);
  const candidates = inventory.filter((entry) => entry.disposition === "archive");
  const beforeBytes = inventory.reduce((total, entry) => total + entry.bytes, 0);
  const candidateBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
  const availableBytes = await availableBytesAt(archiveRoot);
  const minimumFreeBytes = input.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
  const sameDevice = (await lstat(root)).dev === (await lstat(archiveRoot)).dev;
  const largestCandidate = Math.max(0, ...candidates.map((entry) => entry.bytes));
  const preflightRequiredBytes = minimumFreeBytes + (sameDevice ? largestCandidate : candidateBytes);
  const capacityStatus = availableBytes >= preflightRequiredBytes ? "passed" : "failed";
  const orphanTemporaryFiles = await findOrphanTemporaryFiles(archiveRoot, now);
  const id = manifestID(now);
  const manifest: ArtifactLifecycleManifest = {
    action: input.apply ? "artifact-lifecycle.apply" : "artifact-lifecycle.report",
    application_support: {
      after_bytes: null,
      before_bytes: beforeBytes,
      target_bytes: APPLICATION_SUPPORT_TARGET_BYTES,
      target_status: input.apply ? "failed" : "pending_apply"
    },
    archive_root: archiveRoot,
    audit: input.apply ? { ...authorize(input.actor), applied_at: now.toISOString() } : null,
    capacity: {
      available_bytes: availableBytes,
      candidate_bytes: candidateBytes,
      minimum_free_bytes: minimumFreeBytes,
      preflight_required_bytes: preflightRequiredBytes,
      status: capacityStatus
    },
    contract: ARTIFACT_LIFECYCLE_CONTRACT,
    created_at: now.toISOString(),
    dry_run: !input.apply,
    inventory,
    manifest_id: id,
    moved: [],
    orphan_temporary_files: orphanTemporaryFiles.map((path) => relative(archiveRoot, path)),
    policy: lifecyclePolicy(),
    root,
    summary: summarize(inventory)
  };

  if (!input.apply) {
    await writeJSONAtomically(reportPath, manifest);
    return manifest;
  }
  if (!input.confirmConsumerZero) throw new Error("--confirm-consumer-zero is required for apply");
  if (!input.confirmRestoreTested) throw new Error("--confirm-restore-tested is required for apply");
  if (capacityStatus !== "passed") throw new Error("artifact lifecycle capacity preflight failed");
  if (candidates.some((entry) => entry.active_runtime_reference)) {
    throw new Error("artifact lifecycle refuses to archive an active runtime reference");
  }

  const archiveManifestPath = join(archiveRoot, "manifests", `${id}.json`);
  const liveIndexPath = join(root, "artifact-lifecycle", "index.json");
  await writeJSONAtomically(archiveManifestPath, manifest);
  await writeJSONAtomically(liveIndexPath, manifest);
  for (const temporary of orphanTemporaryFiles) await rm(temporary, { force: true });
  for (const entry of candidates) {
    const digest = entry.sha256;
    if (!digest) throw new Error(`archive candidate has no immutable hash: ${entry.path}`);
    const source = safeJoin(root, entry.path);
    const objectPath = join(archiveRoot, "objects", digest.slice(0, 2), digest);
    await copyToObject(source, objectPath, entry.bytes, digest);
    await rm(source, { force: false });
    manifest.moved.push({ bytes: entry.bytes, object_path: relative(archiveRoot, objectPath), path: entry.path, sha256: digest });
    await writeJSONAtomically(archiveManifestPath, manifest);
    await writeJSONAtomically(liveIndexPath, manifest);
  }
  await removeEmptyDirectories(root, candidates.map((entry) => dirname(safeJoin(root, entry.path))));
  manifest.application_support.after_bytes = await directoryBytes(root);
  manifest.application_support.target_status = manifest.application_support.after_bytes <= APPLICATION_SUPPORT_TARGET_BYTES
    ? "passed"
    : "failed";
  await writeJSONAtomically(archiveManifestPath, manifest);
  await writeJSONAtomically(liveIndexPath, manifest);
  await writeJSONAtomically(reportPath, manifest);
  return manifest;
}

export async function restoreArtifactLifecycle(input: ArtifactRestoreInput): Promise<Record<string, unknown>> {
  const authorization = authorize(input);
  const root = resolve(input.root);
  const manifestPath = resolve(input.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactLifecycleManifest;
  if (manifest.contract !== ARTIFACT_LIFECYCLE_CONTRACT || !Array.isArray(manifest.moved)) {
    throw new Error("unsupported artifact lifecycle manifest");
  }
  const archiveRoot = resolve(manifest.archive_root);
  const planned = manifest.moved.map((entry) => ({ bytes: entry.bytes, path: entry.path, sha256: entry.sha256 }));
  const report: Record<string, unknown> = {
    action: "artifact-lifecycle.restore",
    audit: { ...authorization, restored_at: new Date().toISOString() },
    dry_run: !input.apply,
    manifest_id: manifest.manifest_id,
    planned,
    restored: [] as string[]
  };
  if (!input.apply) {
    await writeJSONAtomically(resolve(input.reportPath), report);
    return report;
  }
  for (const entry of manifest.moved) {
    const source = safeJoin(archiveRoot, entry.object_path);
    const target = safeJoin(root, entry.path);
    const current = await lstat(target).catch(() => undefined);
    if (current) {
      if (!current.isFile() || await sha256File(target) !== entry.sha256) {
        throw new Error(`restore target already exists with different content: ${entry.path}`);
      }
      continue;
    }
    await copyToTarget(source, target, entry.bytes, entry.sha256);
    (report.restored as string[]).push(entry.path);
  }
  await writeJSONAtomically(resolve(input.reportPath), report);
  return report;
}

export function lifecyclePolicy() {
  return {
    database_backup: {
      owner: "runtime-operator",
      limit: "keep one freshest verified full backup in live root; archive older copies",
      maximum_age_days: 30,
      maximum_bytes: 1_500_000_000,
      minimum_count: 1
    },
    evidence_snapshot: {
      owner: "evidence-producer",
      limit: "manifest/query/hash/diff remain live; full DB snapshots move to content-addressed archive",
      maximum_age_days: 0,
      maximum_bytes: 0,
      minimum_count: 0
    },
    issue_log: {
      owner: "runner-runtime",
      limit: "active launchd logs stay live; rotations are archived after 30 days or above 128 MiB",
      maximum_age_days: 30,
      maximum_bytes: 128 * 1024 * 1024,
      minimum_count: 2
    },
    migration_rehearsal: {
      owner: "migration-operator",
      limit: "reports and hashes remain live; full DB rehearsal copies move to content-addressed archive",
      maximum_age_days: 0,
      maximum_bytes: 0,
      minimum_count: 0
    },
    old_binary: {
      owner: "release-operator",
      limit: "only launchd binary, matching stamp, and runtime wasm remain live",
      maximum_age_days: 0,
      maximum_bytes: 96 * 1024 * 1024,
      minimum_count: 1
    }
  } as const;
}

async function buildInventory(root: string, now: Date): Promise<ArtifactInventoryEntry[]> {
  const paths = await walkFiles(root);
  const backupGroups = newestBackupGroup(paths);
  const entries: ArtifactInventoryEntry[] = [];
  for (const path of paths) {
    const rel = relative(root, path).replaceAll(sep, "/");
    if (rel.startsWith("artifact-lifecycle/")) continue;
    const stats = await stat(path);
    const classification = classify(rel, backupGroups);
    const mutable = classification.active && isMutable(rel);
    const secret = classification.kind === "runtime_secret";
    const digest = secret || mutable ? null : await sha256File(path);
    entries.push({
      active_runtime_reference: classification.active,
      authority: classification.authority,
      bytes: stats.size,
      created_at: stats.birthtime.toISOString(),
      disposition: classification.disposition,
      generator: classification.generator,
      hash_status: secret ? "redacted" : mutable ? "active_mutable" : "sha256",
      kind: classification.kind,
      last_verified_at: classification.lastVerified ? stats.mtime.toISOString() : null,
      owner: classification.owner,
      path: rel,
      restore_value: classification.restoreValue,
      retention_class: classification.retentionClass,
      sha256: digest
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function classify(path: string, newestBackup: Set<string>): {
  active: boolean;
  authority: ArtifactInventoryEntry["authority"];
  disposition: ArtifactDisposition;
  generator: string;
  kind: ArtifactKind;
  lastVerified: boolean;
  owner: string;
  restoreValue: ArtifactInventoryEntry["restore_value"];
  retentionClass: string;
} {
  const archive = (kind: ArtifactKind, retentionClass: string, owner: string, generator: string, restoreValue: ArtifactInventoryEntry["restore_value"] = "operational") => ({
    active: false, authority: "derived" as const, disposition: "archive" as const, generator, kind,
    lastVerified: true, owner, restoreValue, retentionClass
  });
  if (isSecret(path)) return {
    active: true, authority: "secret", disposition: "keep", generator: "runtime configuration", kind: "runtime_secret",
    lastVerified: false, owner: "runtime-operator", restoreValue: "secret_reinject", retentionClass: "runtime-secret-active"
  };
  if (/^state\/runner\.db(?:-wal|-shm)?$/.test(path)) return {
    active: true, authority: "authority", disposition: "keep", generator: "runner SQLite writer", kind: "authority_database",
    lastVerified: true, owner: "runner-runtime", restoreValue: "critical", retentionClass: "authority-active"
  };
  if (/^state\/runner\.db(?:\.|-).+/.test(path)) return archive("database_backup", "legacy-db-backup-archive", "runtime-operator", "manual pre-change backup", "critical");
  if (path.startsWith("backups/")) {
    const group = path.split("/").slice(0, 2).join("/");
    return newestBackup.has(group) ? {
      active: false, authority: "derived", disposition: "keep", generator: "backup export/manual online backup", kind: "database_backup",
      lastVerified: true, owner: "runtime-operator", restoreValue: "critical", retentionClass: "fresh-restore-backup"
    } : archive("database_backup", "database-backup-archive", "runtime-operator", "backup export/manual online backup", "critical");
  }
  if (path.startsWith("evidence/") && isDatabaseImage(path)) return archive("evidence_snapshot", "evidence-full-snapshot-archive", "evidence-producer", "verification rehearsal");
  if (path.startsWith("evidence/")) return {
    active: false, authority: "derived", disposition: "keep", generator: "verification collector", kind: "evidence_manifest",
    lastVerified: true, owner: "evidence-producer", restoreValue: "reproducible", retentionClass: "evidence-manifest-live"
  };
  if (path.startsWith("migration-artifacts/") && isDatabaseImage(path)) return archive("migration_snapshot", "migration-full-snapshot-archive", "migration-operator", "migration rehearsal", "critical");
  if (path.startsWith("migration-artifacts/")) return {
    active: false, authority: "derived", disposition: "keep", generator: "migration rehearsal", kind: "migration_manifest",
    lastVerified: true, owner: "migration-operator", restoreValue: "reproducible", retentionClass: "migration-manifest-live"
  };
  if (path.startsWith("bin/") && !/^bin\/(?:codex-issue-runner(?:\.build\.stamp)?|photon_rs_bg\.wasm)$/.test(path)) {
    return archive("runtime_binary", "legacy-binary-archive", "release-operator", "historic deployment");
  }
  if (path.startsWith("bin/")) return {
    active: true, authority: "derived", disposition: "keep", generator: "atomic release deployment", kind: "runtime_binary",
    lastVerified: true, owner: "release-operator", restoreValue: "operational", retentionClass: "runtime-binary-active"
  };
  if (path.startsWith("logs/") && !/^logs\/(?:launchd\.out\.log|launchd\.err\.log|daemon-lifecycle\.log)$/.test(path)) {
    return archive("issue_log", "issue-log-archive", "runner-runtime", "runtime logging");
  }
  return {
    active: true, authority: "derived", disposition: "keep", generator: runtimeGenerator(path), kind: path.startsWith("logs/") ? "issue_log" : "runtime_artifact",
    lastVerified: false, owner: "runner-runtime", restoreValue: "operational", retentionClass: "runtime-active"
  };
}

function newestBackupGroup(paths: string[]): Set<string> {
  const groups = new Map<string, number>();
  for (const path of paths) {
    const match = path.replaceAll("\\", "/").match(/\/backups\/([^/]+)/);
    if (!match) continue;
    const group = `backups/${match[1]}`;
    const timestamp = statTimestamp(path);
    groups.set(group, Math.max(groups.get(group) ?? 0, timestamp));
  }
  const newest = [...groups].sort((left, right) => right[1] - left[1])[0]?.[0];
  return new Set(newest ? [newest] : []);
}

function statTimestamp(path: string): number {
  try { return Bun.file(path).lastModified; } catch { return 0; }
}

function isDatabaseImage(path: string): boolean {
  return /(?:^|\/)[^/]+\.(?:db|sqlite|snapshot)$/i.test(path) || /(?:runner\.db|database-backup)/i.test(basename(path));
}

function isMutable(path: string): boolean {
  return path.startsWith("state/") || path.startsWith("logs/") || path.startsWith(".runner/");
}

function isSecret(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "auth_token" || name === "auth.json" || name === ".env" || /\.(?:key|pem)$/.test(name);
}

function runtimeGenerator(path: string): string {
  if (path.startsWith("state/artifacts/")) return "content-addressed Evidence/issue-log collector";
  if (path.startsWith("state/uploads/")) return "upload service";
  if (path.startsWith("state/web/")) return "atomic release deployment";
  if (path.startsWith(".runner/sessions/")) return "provider session runtime";
  return "runner runtime";
}

async function copyToObject(source: string, target: string, bytes: number, digest: string): Promise<void> {
  const existing = await lstat(target).catch(() => undefined);
  if (existing) {
    if (!existing.isFile() || existing.size !== bytes || await sha256File(target) !== digest) {
      throw new Error(`content-addressed archive collision: ${digest}`);
    }
    return;
  }
  await copyToTarget(source, target, bytes, digest);
}

async function copyToTarget(source: string, target: string, bytes: number, digest: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.partial-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const copied = await stat(temporary);
    if (copied.size !== bytes || await sha256File(temporary) !== digest) throw new Error(`archive copy verification failed: ${source}`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact lifecycle refuses symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function findOrphanTemporaryFiles(archiveRoot: string, now: Date): Promise<string[]> {
  const objectRoot = join(archiveRoot, "objects");
  const paths = await walkFiles(objectRoot).catch((error) => isMissing(error) ? [] : Promise.reject(error));
  const cutoff = now.getTime() - 60 * 60 * 1000;
  const result: string[] = [];
  for (const path of paths) {
    if (!basename(path).includes(".partial-") || (await stat(path)).mtimeMs >= cutoff) continue;
    result.push(path);
  }
  return result;
}

async function directoryBytes(root: string): Promise<number> {
  const paths = await walkFiles(root);
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

async function availableBytesAt(path: string): Promise<number> {
  const values = await statfs(path);
  return Number(values.bavail) * Number(values.bsize);
}

async function removeEmptyDirectories(root: string, candidates: string[]): Promise<void> {
  const unique = [...new Set(candidates)].sort((left, right) => right.length - left.length);
  for (const directory of unique) {
    if (directory === root || !directory.startsWith(`${root}${sep}`)) continue;
    const contents = await readdir(directory).catch(() => ["not-empty"]);
    if (contents.length === 0) await rmdir(directory);
  }
}

async function writeJSONAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.partial-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function summarize(inventory: ArtifactInventoryEntry[]) {
  const archive = inventory.filter((entry) => entry.disposition === "archive");
  const keep = inventory.filter((entry) => entry.disposition === "keep");
  return {
    archive_bytes: archive.reduce((total, entry) => total + entry.bytes, 0),
    archive_files: archive.length,
    inventory_bytes: inventory.reduce((total, entry) => total + entry.bytes, 0),
    inventory_files: inventory.length,
    keep_bytes: keep.reduce((total, entry) => total + entry.bytes, 0),
    keep_files: keep.length
  };
}

function authorize(actor: Actor | undefined): Actor {
  if (!actor?.actor.trim() || actor.actor.trim().toLowerCase() === "llm") throw new Error("--actor is required and cannot be llm");
  if (!actor.auditRef.trim()) throw new Error("--audit-ref is required");
  if (!actor.reason.trim()) throw new Error("--reason is required");
  return { actor: actor.actor.trim(), auditRef: actor.auditRef.trim(), reason: actor.reason.trim() };
}

function safeJoin(root: string, path: string): string {
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new Error(`artifact path escapes root: ${path}`);
  return target;
}

function manifestID(now: Date): string {
  return `artifact-lifecycle-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
