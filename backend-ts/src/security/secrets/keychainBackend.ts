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

type MetadataDocument = { schema_version: "xw.secret-store.keychain.v1"; secrets: Record<string, SecretMetadata> };
export type KeychainCommandRunner = (args: string[], input?: string) => { exitCode: number; stderr: string; stdout: string };

export class KeychainSecretStore implements SecretStore {
  readonly backend = "keychain" as const;
  private readonly metadataPath: string;

  constructor(stateDir: string, private readonly run: KeychainCommandRunner = runSecurity) {
    this.metadataPath = join(stateDir, "secrets", "keychain-metadata.json");
  }

  describe(ref: string): SecretMetadata | null {
    return this.document().secrets[secretName(ref)] ?? null;
  }

  put(name: string, value: string): SecretMetadata {
    const normalized = normalizeSecretName(name);
    const document = this.document();
    if (document.secrets[normalized]?.status === "active") {
      throw new SecretStoreError("secret_already_exists", "secret already exists; use rotate");
    }
    this.writeKeychain(normalized, requiredSecretValue(value));
    const now = new Date().toISOString();
    const metadata: SecretMetadata = {
      backend: this.backend,
      created_at: document.secrets[normalized]?.created_at ?? now,
      name: normalized,
      ref: secretRef(normalized),
      status: "active",
      version: (document.secrets[normalized]?.version ?? 0) + 1
    };
    document.secrets[normalized] = metadata;
    this.write(document);
    return metadata;
  }

  resolve(ref: string): string {
    const name = secretName(ref);
    const metadata = this.document().secrets[name];
    if (!metadata) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (metadata.status === "revoked") throw new SecretStoreError("secret_revoked", `secret is revoked: ${ref}`);
    const result = this.run(["find-generic-password", "-a", name, "-s", serviceName(), "-w"]);
    if (result.exitCode !== 0) throw new SecretStoreError("secret_backend_failed", `keychain secret is unavailable: ${ref}`);
    return result.stdout.replace(/\r?\n$/, "");
  }

  rotate(ref: string, value: string): SecretMetadata {
    const name = secretName(ref);
    const document = this.document();
    const current = document.secrets[name];
    if (!current) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (current.status === "revoked") throw new SecretStoreError("secret_revoked", `secret is revoked: ${ref}`);
    this.writeKeychain(name, requiredSecretValue(value));
    const metadata: SecretMetadata = {
      ...current,
      rotated_at: new Date().toISOString(),
      status: "active",
      version: current.version + 1
    };
    document.secrets[name] = metadata;
    this.write(document);
    return metadata;
  }

  revoke(ref: string): SecretMetadata {
    const name = secretName(ref);
    const document = this.document();
    const current = document.secrets[name];
    if (!current) throw new SecretStoreError("secret_not_found", `secret is not configured: ${ref}`);
    if (current.status === "revoked") return current;
    const result = this.run(["delete-generic-password", "-a", name, "-s", serviceName()]);
    if (result.exitCode !== 0) throw new SecretStoreError("secret_backend_failed", `keychain secret cannot be revoked: ${ref}`);
    const metadata: SecretMetadata = { ...current, revoked_at: new Date().toISOString(), status: "revoked" };
    document.secrets[name] = metadata;
    this.write(document);
    return metadata;
  }

  private writeKeychain(name: string, value: string): void {
    const result = this.run([
      "add-generic-password", "-a", name, "-s", serviceName(), "-U", "-w"
    ], `${value}\n`);
    if (result.exitCode !== 0) throw new SecretStoreError("secret_backend_failed", "keychain secret cannot be written");
  }

  private document(): MetadataDocument {
    try {
      const value = JSON.parse(readFileSync(this.metadataPath, "utf8")) as MetadataDocument;
      if (value.schema_version !== "xw.secret-store.keychain.v1" || !value.secrets || typeof value.secrets !== "object") {
        throw new Error("invalid schema");
      }
      return value;
    } catch (error) {
      if (missing(error)) return { schema_version: "xw.secret-store.keychain.v1", secrets: {} };
      throw new SecretStoreError("secret_backend_failed", "keychain metadata is invalid");
    }
  }

  private write(document: MetadataDocument): void {
    mkdirSync(dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.metadataPath);
  }
}

function runSecurity(args: string[], input = ""): ReturnType<KeychainCommandRunner> {
  const result = Bun.spawnSync(["/usr/bin/security", ...args], {
    stdin: input === "" ? undefined : Buffer.from(input),
    stderr: "pipe",
    stdout: "pipe"
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout)
  };
}

function serviceName(): string {
  return "com.codex-issue-runner.xuanwu";
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
