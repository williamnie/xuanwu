export const SECRET_REF_PREFIX = "secret://";

export type SecretBackendID = "file" | "keychain";
export type SecretStatus = "active" | "revoked";

export type SecretMetadata = {
  backend: SecretBackendID;
  created_at: string;
  name: string;
  ref: string;
  revoked_at?: string;
  rotated_at?: string;
  status: SecretStatus;
  version: number;
};

export interface SecretStore {
  readonly backend: SecretBackendID;
  describe(ref: string): SecretMetadata | null;
  put(name: string, value: string): SecretMetadata;
  resolve(ref: string): string;
  revoke(ref: string): SecretMetadata;
  rotate(ref: string, value: string): SecretMetadata;
}

export type SecretMutation = {
  actor: string;
  metadata: SecretMetadata;
  operation: "created" | "revoked" | "rotated";
  reason: string;
};

export type SecretAuditSink = (mutation: SecretMutation) => void;

export class SecretStoreError extends Error {
  constructor(
    readonly code: "invalid_secret_name" | "invalid_secret_ref" | "secret_already_exists" |
      "secret_not_found" | "secret_revoked" | "secret_value_required" | "secret_backend_failed",
    message: string
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

export function secretRef(name: string): string {
  return `${SECRET_REF_PREFIX}${normalizeSecretName(name).split("/").map(encodeURIComponent).join("/")}`;
}

export function secretName(ref: string): string {
  const value = ref.trim();
  if (!value.startsWith(SECRET_REF_PREFIX)) {
    throw new SecretStoreError("invalid_secret_ref", "secret ref must use secret://");
  }
  try {
    return normalizeSecretName(value.slice(SECRET_REF_PREFIX.length).split("/").map(decodeURIComponent).join("/"));
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw new SecretStoreError("invalid_secret_ref", "secret ref is invalid");
  }
}

export function normalizeSecretName(name: string): string {
  const value = name.trim();
  if (value === "" || value.length > 512 || value.startsWith("/") || value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") || /[\0\r\n]/.test(value)) {
    throw new SecretStoreError("invalid_secret_name", "secret name is invalid");
  }
  return value;
}

export function requiredSecretValue(value: string): string {
  if (value === "") throw new SecretStoreError("secret_value_required", "secret value is required");
  return value;
}
