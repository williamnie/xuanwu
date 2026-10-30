export const LEGACY_AUTOMATION_ARCHIVE_CONTRACT = "xw.legacy-automation-archive.v1";

export const LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT = "xw.legacy-automation-cleanup-report.v1";

export type Authorization = {
  actor: string;
  actorKind: "automation" | "system" | "user";
  auditRef: string;
  reason: string;
};

export type LegacyAutomationCleanupInput = {
  actor?: string;
  actorKind?: Authorization["actorKind"];
  apply?: boolean;
  archivePath?: string;
  auditRef?: string;
  backupPath?: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  confirmTables?: string;
  dbPath: string;
  reason?: string;
  releaseRef?: string;
  reportPath: string;
  sourceRoot?: string;
};
