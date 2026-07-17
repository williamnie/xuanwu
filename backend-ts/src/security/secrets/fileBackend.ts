import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  normalizeSecretName,
  requiredSecretValue,
  secretName,
  secretRef,
  SecretStoreError,
  type SecretMetadata,
  type SecretStore
} from "./contracts.ts";

type EncryptedSecret = SecretMetadata & { auth_tag: string; ciphertext: string; iv: string };
type FileDocument = { schema_version: "xw.secret-store.file.v1"; secrets: Record<string, EncryptedSecret> };

export class FileSecretStore implements SecretStore {
  readonly backend = "file" as const;
  readonly path: string;
  private readonly keyPath: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "secrets", "store.json");
    this.keyPath = join(stateDir, "secrets", "master.key");
  }

  describe(ref: string): SecretMetadata | null {
    const record = this.document().secrets[secretName(ref)];
    return record ? publicMetadata(record) : null;
  }

  put(name: string, value: string): SecretMetadata {
    const normalized = normalizeSecretName(name);
    const document = this.document();
    if (document.secrets[normalized]?.status === "active") {
      throw new SecretStoreError("secret_already_exists", "secret already exists; use rotate");
    }
    const now = new Date().toISOString();
    const metadata: SecretMetadata = {
      backend: this.backend,
      created_at: document.secrets[normalized]?.created_at ?? now,
      name: normalized,
      ref: secretRef(normalized),
      status: "active",
      version: (document.secrets[normalized]?.version ?? 0) + 1
    };
    document.secrets[normalized] = this.encrypt(metadata, requiredSecretValue(value));
    this.write(document);
    return metadata;
  }

  resolve(ref: string): string {
    const record = this.document().secrets[secretName(ref)];
    if (!record) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (record.status === "revoked") throw new SecretStoreError("secret_revoked", `secret is revoked: ${ref}`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(false), Buffer.from(record.iv, "base64"));
      decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new SecretStoreError("secret_backend_failed", `secret cannot be decrypted: ${ref}`);
    }
  }

  rotate(ref: string, value: string): SecretMetadata {
    const name = secretName(ref);
    const document = this.document();
    const current = document.secrets[name];
    if (!current) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (current.status === "revoked") throw new SecretStoreError("secret_revoked", `secret is revoked: ${ref}`);
    const metadata: SecretMetadata = {
      backend: this.backend,
      created_at: current.created_at,
      name,
      ref: current.ref,
      rotated_at: new Date().toISOString(),
      status: "active",
      version: current.version + 1
    };
    document.secrets[name] = this.encrypt(metadata, requiredSecretValue(value));
    this.write(document);
    return metadata;
  }

  revoke(ref: string): SecretMetadata {
    const name = secretName(ref);
    const document = this.document();
    const current = document.secrets[name];
    if (!current) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (current.status === "revoked") return publicMetadata(current);
    const metadata: SecretMetadata = {
      backend: this.backend,
      created_at: current.created_at,
      name,
      ref: current.ref,
      revoked_at: new Date().toISOString(),
      rotated_at: current.rotated_at,
      status: "revoked",
      version: current.version
    };
    document.secrets[name] = { ...metadata, auth_tag: "", ciphertext: "", iv: "" };
    this.write(document);
    return metadata;
  }

  private document(): FileDocument {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as FileDocument;
      if (value.schema_version !== "xw.secret-store.file.v1" || !value.secrets || typeof value.secrets !== "object") {
        throw new Error("invalid schema");
      }
      return value;
    } catch (error) {
      if (missing(error)) return { schema_version: "xw.secret-store.file.v1", secrets: {} };
      throw new SecretStoreError("secret_backend_failed", "secret store file is invalid");
    }
  }

  private encrypt(metadata: SecretMetadata, value: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(true), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ...metadata,
      auth_tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64")
    };
  }

  private key(create: boolean): Buffer {
    try {
      const key = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "base64");
      if (key.length !== 32) throw new Error("invalid key");
      return key;
    } catch (error) {
      if (!missing(error) || !create) {
        throw new SecretStoreError("secret_backend_failed", "secret store master key is missing or invalid");
      }
      const key = randomBytes(32);
      mkdirSync(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
      chmodSync(this.keyPath, 0o600);
      return key;
    }
  }

  private write(document: FileDocument): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}

function publicMetadata(record: EncryptedSecret): SecretMetadata {
  const { auth_tag: _authTag, ciphertext: _ciphertext, iv: _iv, ...metadata } = record;
  return metadata;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
