import { dirname } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { registerSecretForRedaction } from "../redactionRegistry.ts";
import {
  SECRET_REF_PREFIX,
  SecretStoreError,
  type SecretAuditSink,
  type SecretBackendID,
  type SecretMetadata,
  type SecretStore
} from "./contracts.ts";
import { FileSecretStore } from "./fileBackend.ts";
import { KeychainSecretStore } from "./keychainBackend.ts";

export class SecretService {
  constructor(readonly store: SecretStore, private readonly audit?: SecretAuditSink) {}

  describe(ref: string): SecretMetadata | null {
    return this.store.describe(ref);
  }

  put(name: string, value: string, actor: string, reason: string): SecretMetadata {
    const audit = auditContext(actor, reason);
    const metadata = this.store.put(name, value);
    registerSecretForRedaction(value);
    this.audit?.({ ...audit, metadata, operation: "created" });
    return metadata;
  }

  resolve(ref: string): string {
    const value = this.store.resolve(ref);
    registerSecretForRedaction(value);
    return value;
  }

  resolveOptional(ref: string): string {
    if (ref.trim() === "") return "";
    return this.resolve(ref);
  }

  revoke(ref: string, actor: string, reason: string): SecretMetadata {
    const audit = auditContext(actor, reason);
    const metadata = this.store.revoke(ref);
    this.audit?.({ ...audit, metadata, operation: "revoked" });
    return metadata;
  }

  rotate(ref: string, value: string, actor: string, reason: string): SecretMetadata {
    const audit = auditContext(actor, reason);
    const metadata = this.store.rotate(ref, value);
    registerSecretForRedaction(value);
    this.audit?.({ ...audit, metadata, operation: "rotated" });
    return metadata;
  }

  putOrRotate(name: string, value: string, actor: string, reason: string): SecretMetadata {
    const ref = `secret://${name.split("/").map(encodeURIComponent).join("/")}`;
    const current = this.describe(ref);
    if (!current || current.status === "revoked") return this.put(name, value, actor, reason);
    if (this.resolve(ref) === value) return current;
    return this.rotate(ref, value, actor, reason);
  }
}

export function createSecretService(input: {
  audit?: SecretAuditSink;
  backend?: SecretBackendID;
  stateDir: string;
}): SecretService {
  const backend = input.backend ?? configuredSecretBackend();
  const store = backend === "keychain" ? new KeychainSecretStore(input.stateDir) : new FileSecretStore(input.stateDir);
  return new SecretService(store, input.audit);
}

export function createDatabaseSecretService(
  database: RunnerDatabase,
  options: { backend?: SecretBackendID; stateDir?: string } = {}
): SecretService {
  return createSecretService({
    backend: options.backend,
    stateDir: options.stateDir ?? dirname(database.path),
    audit: (mutation) => createPiActionEvent(database, {
      action_id: `secret:${mutation.operation}:${crypto.randomUUID()}`,
      actor: mutation.actor,
      event_type: `secret.${mutation.operation}`,
      payload_json: JSON.stringify({
        backend: mutation.metadata.backend,
        secret_ref: mutation.metadata.ref,
        version: mutation.metadata.version
      }),
      reason: mutation.reason,
      result_json: JSON.stringify({ status: mutation.metadata.status })
    })
  });
}

export function resolveSecretLocator(service: SecretService, ref: string, env: Record<string, string | undefined> = Bun.env): string {
  const locator = ref.trim();
  if (locator.startsWith(SECRET_REF_PREFIX)) return service.resolve(locator);
  if (locator.startsWith("env://")) {
    const key = locator.slice("env://".length);
    const value = env[key]?.trim() ?? "";
    if (value === "") throw new SecretStoreError("secret_not_found", `secret environment key is not configured: ${key}`);
    registerSecretForRedaction(value);
    return value;
  }
  throw new SecretStoreError("invalid_secret_ref", "secret locator must use secret:// or env://");
}

function configuredSecretBackend(): SecretBackendID {
  const value = (Bun.env.XUANWU_SECRET_BACKEND ?? "file").trim();
  if (value === "file" || value === "keychain") return value;
  throw new SecretStoreError("secret_backend_failed", "XUANWU_SECRET_BACKEND must be file or keychain");
}

function requiredAuditText(value: string, label: string): string {
  const text = value.trim();
  if (text === "") throw new SecretStoreError("secret_backend_failed", `${label} is required for secret mutation audit`);
  return text;
}

function auditContext(actor: string, reason: string): { actor: string; reason: string } {
  return { actor: requiredAuditText(actor, "actor"), reason: requiredAuditText(reason, "reason") };
}
