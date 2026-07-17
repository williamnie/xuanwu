import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

const SNAPSHOT_SCHEMA = "xuanwu.backup-manifest.v1";
const ENCRYPTED_MAGIC = "XWBACKUP-ENCRYPTED-V1\n";
const VOLATILE_PATH = /^(?:logs|tmp|web)(?:\/|$)|(?:^|\/)[^/]+\.(?:log|pid)$/i;

type Actor = {
  actor: string;
  actorKind: "automation" | "system" | "user";
  auditRef: string;
  reason: string;
};

export type BackupExportInput = Actor & {
  dbPath: string;
  encrypt?: boolean;
  outputPath: string;
  passphrase?: string;
  retain?: number;
  stateDir: string;
};

export type BackupImportInput = Actor & {
  apply: boolean;
  inputPath: string;
  passphrase?: string;
  targetStateDir: string;
};

export type BackupVerifyInput = { inputPath: string; passphrase?: string };

type SnapshotEntry = { bytes: number; path: string; sha256: string };
type SecretRef = { path: string; restore: string };
type Manifest = {
  audit: Actor & { action: "backup.export"; retention_deleted: string[] };
  created_at: string;
  database: { path: "database/runner.db"; quick_check: string; schema_migrations: string[] };
  encryption: { enabled: boolean; format: "aes-256-gcm+scrypt" | "none" };
  files: SnapshotEntry[];
  schema_version: typeof SNAPSHOT_SCHEMA;
  secret_refs: SecretRef[];
  snapshot_id: string;
  source_of_truth: "runner.db is authoritative; copied state files are configuration and artifact companions";
};

type VerifiedBundle = { files: Map<string, Buffer>; manifest: Manifest };

export async function exportBackup(input: BackupExportInput): Promise<Record<string, unknown>> {
  const authorization = authorize(input);
  const stateDir = resolveRequired(input.stateDir, "--state-dir");
  const dbPath = resolveRequired(input.dbPath, "--db");
  const outputPath = resolveRequired(input.outputPath, "--output");
  if (input.encrypt && !input.passphrase) throw new Error("--passphrase-file is required with --encrypt");
  if (await exists(outputPath)) throw new Error(`backup output already exists: ${outputPath}`);
  if (!(await stat(stateDir)).isDirectory()) throw new Error(`state directory does not exist: ${stateDir}`);
  if (!(await stat(dbPath)).isFile()) throw new Error(`database does not exist: ${dbPath}`);

  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const retentionDeleted = await retentionPlan(parent, input.retain, outputPath);
  const staging = await mkdtemp(join(parent, ".xuanwu-backup-staging-"));
  try {
    const files: SnapshotEntry[] = [];
    const dbTarget = join(staging, "database", "runner.db");
    await mkdir(dirname(dbTarget), { recursive: true, mode: 0o700 });
    const database = snapshotDatabase(dbPath, dbTarget);
    files.push(await entryFor(staging, "database/runner.db"));

    const secretRefs: SecretRef[] = [];
    for await (const candidate of walkStateFiles(stateDir)) {
      const stateRelative = relative(stateDir, candidate).replaceAll(sep, "/");
      if (samePath(candidate, dbPath) || samePath(candidate, `${dbPath}-wal`) || samePath(candidate, `${dbPath}-shm`)) continue;
      if (VOLATILE_PATH.test(stateRelative)) continue;
      if (isSecretMaterialPath(stateRelative)) {
        secretRefs.push({
          path: `state/${stateRelative}`,
          restore: "Excluded from every backup. Resolve this secret reference from the protected environment or secret store after restore."
        });
        continue;
      }
      const target = join(staging, "state", stateRelative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(candidate, target);
      await chmod(target, 0o600);
      files.push(await entryFor(staging, `state/${stateRelative}`));
    }

    const now = new Date().toISOString();
    const manifest: Manifest = {
      audit: { ...authorization, action: "backup.export", retention_deleted: retentionDeleted },
      created_at: now,
      database,
      encryption: { enabled: Boolean(input.encrypt), format: input.encrypt ? "aes-256-gcm+scrypt" : "none" },
      files,
      schema_version: SNAPSHOT_SCHEMA,
      secret_refs: secretRefs.sort((left, right) => left.path.localeCompare(right.path)),
      snapshot_id: `backup:${randomUUID()}`,
      source_of_truth: "runner.db is authoritative; copied state files are configuration and artifact companions"
    };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    if (input.encrypt) {
      await writeEncryptedBundle(staging, outputPath, manifest, input.passphrase!);
      await rm(staging, { recursive: true, force: true });
    } else {
      await rename(staging, outputPath);
      await chmod(outputPath, 0o700);
    }

    await applyRetention(retentionDeleted);
    return {
      action: "backup.export",
      audit: authorization,
      database,
      encryption: manifest.encryption,
      files: files.length,
      output: outputPath,
      retention: { deleted: retentionDeleted, retain: input.retain ?? null },
      secret_refs: manifest.secret_refs,
      snapshot_id: manifest.snapshot_id,
      verified: true
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(input: BackupVerifyInput): Promise<Record<string, unknown>> {
  const bundle = await readAndVerifyBundle(resolveRequired(input.inputPath, "--input"), input.passphrase);
  return {
    action: "backup.verify",
    database: bundle.manifest.database,
    encryption: bundle.manifest.encryption,
    files: bundle.manifest.files.length,
    snapshot_id: bundle.manifest.snapshot_id,
    verified: true
  };
}

export async function importBackup(input: BackupImportInput): Promise<Record<string, unknown>> {
  const authorization = authorize(input);
  if (!input.apply) throw new Error("--apply is required for backup import");
  const target = resolveRequired(input.targetStateDir, "--target-state-dir");
  if (await exists(target)) {
    const targetStats = await stat(target);
    if (!targetStats.isDirectory() || (await readdir(target)).length > 0) {
      throw new Error("backup import target must not exist or must be an empty directory");
    }
    await rm(target, { recursive: true, force: true });
  }
  const bundle = await readAndVerifyBundle(resolveRequired(input.inputPath, "--input"), input.passphrase);
  const temporary = `${target}.restore-${randomUUID()}.partial`;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    for (const entry of bundle.manifest.files) {
      const destination = restorePath(temporary, entry.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bundle.files.get(entry.path)!, { mode: 0o600 });
    }
    const restoreAudit = {
      action: "backup.import",
      actor: authorization.actor,
      actor_kind: authorization.actorKind,
      audit_ref: authorization.auditRef,
      imported_at: new Date().toISOString(),
      reason: authorization.reason,
      snapshot_id: bundle.manifest.snapshot_id,
      verification: { quick_check: bundle.manifest.database.quick_check, status: "passed_before_restore" }
    };
    await writeFile(join(temporary, "restore-audit.json"), `${JSON.stringify(restoreAudit, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return {
      action: "backup.import",
      audit: authorization,
      restored_state_dir: target,
      secret_refs_required: bundle.manifest.secret_refs,
      snapshot_id: bundle.manifest.snapshot_id,
      verified: true
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function readAndVerifyBundle(inputPath: string, passphrase: string | undefined): Promise<VerifiedBundle> {
  const inspected = await lstat(inputPath).catch(() => undefined);
  if (!inspected) throw new Error(`backup input does not exist: ${inputPath}`);
  const bundle = inspected.isDirectory()
    ? await readDirectoryBundle(inputPath)
    : await readEncryptedBundle(inputPath, passphrase);
  validateManifest(bundle.manifest);
  if (bundle.manifest.encryption.enabled !== !inspected.isDirectory()) throw new Error("backup encryption metadata does not match its container");
  if (bundle.files.size !== bundle.manifest.files.length) throw new Error("backup contains unexpected or missing payload files");
  for (const entry of bundle.manifest.files) {
    const content = bundle.files.get(entry.path);
    if (!content || content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) {
      throw new Error(`backup checksum failed: ${entry.path}`);
    }
  }
  const db = bundle.files.get(bundle.manifest.database.path);
  if (!db) throw new Error("backup database payload is missing");
  const checkRoot = await mkdtemp(join(tmpdir(), "xuanwu-backup-verify-"));
  try {
    const checkPath = join(checkRoot, "runner.db");
    await writeFile(checkPath, db, { mode: 0o600 });
    const sqlite = new Database(checkPath, { readonly: true, strict: true });
    try {
      const quickCheck = scalar(sqlite, "pragma quick_check");
      if (quickCheck !== "ok" || quickCheck !== bundle.manifest.database.quick_check) {
        throw new Error(`backup database quick_check failed: ${quickCheck}`);
      }
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(checkRoot, { recursive: true, force: true });
  }
  return bundle;
}

async function readDirectoryBundle(root: string): Promise<VerifiedBundle> {
  const raw = await readFile(join(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Manifest;
  const files = new Map<string, Buffer>();
  const actual = new Set<string>();
  for await (const path of walkFiles(root)) {
    const key = relative(root, path).replaceAll(sep, "/");
    if (key === "manifest.json") continue;
    actual.add(key);
    files.set(key, await readFile(path));
  }
  const expected = new Set(manifest.files?.map((entry) => entry.path) ?? []);
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
    throw new Error("backup directory contains unexpected or missing payload files");
  }
  return { files, manifest };
}

async function readEncryptedBundle(path: string, passphrase: string | undefined): Promise<VerifiedBundle> {
  if (!passphrase) throw new Error("--passphrase-file is required for encrypted backup");
  const body = await readFile(path);
  const newline = body.indexOf(0x0a, ENCRYPTED_MAGIC.length);
  if (!body.subarray(0, ENCRYPTED_MAGIC.length).equals(Buffer.from(ENCRYPTED_MAGIC)) || newline < 0) {
    throw new Error("unsupported encrypted backup format");
  }
  const header = JSON.parse(body.subarray(ENCRYPTED_MAGIC.length, newline).toString("utf8")) as { iv: string; salt: string; tag: string };
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(passphrase, header.salt), Buffer.from(header.iv, "base64"));
    decipher.setAuthTag(Buffer.from(header.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(body.subarray(newline + 1)), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8")) as { files: Array<{ data: string; path: string }>; manifest: Manifest };
    return { files: new Map(payload.files.map((file) => [file.path, Buffer.from(file.data, "base64")])), manifest: payload.manifest };
  } catch {
    throw new Error("encrypted backup could not be authenticated; check the passphrase and file integrity");
  }
}

async function writeEncryptedBundle(staging: string, output: string, manifest: Manifest, passphrase: string): Promise<void> {
  const files = await Promise.all(manifest.files.map(async (entry) => ({
    data: (await readFile(join(staging, entry.path))).toString("base64"),
    path: entry.path
  })));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(passphrase, salt.toString("base64")), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ files, manifest })), cipher.final()]);
  const header = JSON.stringify({ algorithm: "aes-256-gcm+scrypt", iv: iv.toString("base64"), salt: salt.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
  const temporary = `${output}.partial-${randomUUID()}`;
  try {
    await writeFile(temporary, Buffer.concat([Buffer.from(ENCRYPTED_MAGIC), Buffer.from(`${header}\n`), encrypted]), { mode: 0o600, flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

function snapshotDatabase(source: string, target: string): Manifest["database"] {
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

async function retentionPlan(parent: string, retain: number | undefined, current: string): Promise<string[]> {
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

async function applyRetention(paths: string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

async function entryFor(root: string, path: string): Promise<SnapshotEntry> {
  const body = await readFile(join(root, path));
  return { bytes: body.byteLength, path, sha256: sha256(body) };
}

async function* walkStateFiles(root: string): AsyncGenerator<string> {
  for await (const file of walkFiles(root)) yield file;
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${path}`);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

function restorePath(root: string, path: string): string {
  if (path === "database/runner.db") return join(root, "runner.db");
  if (!path.startsWith("state/")) throw new Error(`backup payload path is not restorable: ${path}`);
  const destination = resolve(root, path.slice("state/".length));
  if (!destination.startsWith(`${resolve(root)}${sep}`)) throw new Error("backup payload path escapes restore state directory");
  return destination;
}

function validateManifest(manifest: Manifest): void {
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

function safePayloadPath(path: string): boolean {
  return (path === "database/runner.db" || path.startsWith("state/")) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isSecretMaterialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === "auth_token" || name === "auth.json" || name === ".env" || /\.(?:key|pem)$/.test(name)) return true;
  // Secret references are configuration, not secret material, and must survive restore.
  return /(?:^|\/)[^/]*(?:secret|token|private)[^/]*(?:\/|$)/.test(path.toLowerCase()) &&
    !/(?:^|[-_./])ref(?:[-_./]|$)/.test(path.toLowerCase());
}

function authorize(input: Actor): Actor {
  const actor = required(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  if (input.actorKind !== "automation" && input.actorKind !== "system" && input.actorKind !== "user") {
    throw new Error("--actor-kind must be user, system, or automation");
  }
  return { actor, actorKind: input.actorKind, auditRef: required(input.auditRef, "--audit-ref"), reason: required(input.reason, "--reason") };
}

function resolveRequired(value: string, name: string): string {
  return resolve(required(value, name));
}

function required(value: string | undefined, name: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function keyFor(passphrase: string, salt: string): Buffer {
  return scryptSync(passphrase, Buffer.from(salt, "base64"), 32);
}

function scalar(database: Database, sql: string): string {
  const row = database.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
