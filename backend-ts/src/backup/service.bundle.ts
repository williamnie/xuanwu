import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Database } from "bun:sqlite";
import { ENCRYPTED_MAGIC } from "./service.model.ts";
import type { VerifiedBundle, Manifest } from "./service.model.ts";
import { validateManifest, sha256, scalar, keyFor } from "./service.validation.ts";
import { walkFiles } from "./service.filesystem.ts";

export async function readAndVerifyBundle(inputPath: string, passphrase: string | undefined): Promise<VerifiedBundle> {
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

export async function readDirectoryBundle(root: string): Promise<VerifiedBundle> {
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

export async function readEncryptedBundle(path: string, passphrase: string | undefined): Promise<VerifiedBundle> {
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

export async function writeEncryptedBundle(staging: string, output: string, manifest: Manifest, passphrase: string): Promise<void> {
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
