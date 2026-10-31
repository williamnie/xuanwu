import type { sha256 } from "./service.validation.ts";

export const SNAPSHOT_SCHEMA = "xuanwu.backup-manifest.v1";

export const ENCRYPTED_MAGIC = "XWBACKUP-ENCRYPTED-V1\n";

export const VOLATILE_PATH = /^(?:logs|tmp|web)(?:\/|$)|(?:^|\/)[^/]+\.(?:log|pid)$/i;

export type Actor = {
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

export type SnapshotEntry = { bytes: number; path: string; sha256: string };

export type SecretRef = { path: string; restore: string };

export type Manifest = {
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

export type VerifiedBundle = { files: Map<string, Buffer>; manifest: Manifest };
