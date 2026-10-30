import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  LEGACY_AUTOMATION_DROP_MIGRATION_ID,
  LEGACY_AUTOMATION_DROP_TABLES
} from "./schema/053_drop_legacy_automation_tables.ts";
import { resolveRequired, open, databaseHealth } from "./legacyAutomationCleanupValidation.ts";
import { LEGACY_AUTOMATION_ARCHIVE_CONTRACT } from "./legacyAutomationCleanupModel.ts";

export function verifyLegacyAutomationArchive(path: string): Record<string, unknown> {
  const archivePath = resolveRequired(path, "--archive");
  const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
    archive_sha256?: string;
    contract?: string;
    payload?: Record<string, unknown>;
  };
  if (archive.contract !== LEGACY_AUTOMATION_ARCHIVE_CONTRACT || !archive.payload) {
    throw new Error("unsupported legacy Automation archive contract");
  }
  const actual = sha256(stableJSON(archive.payload));
  if (!archive.archive_sha256 || archive.archive_sha256 !== actual) {
    throw new Error("legacy Automation archive checksum failed");
  }
  return { archive: archivePath, archive_sha256: actual, contract: archive.contract, verified: true };
}

export function inventoryFor(sqlite: Database) {
  const tables = LEGACY_AUTOMATION_DROP_TABLES.map((table) => ({
    create_sql: schemaSQL(sqlite, "table", table),
    name: table,
    rows: tableExists(sqlite, table) ? count(sqlite, table) : null
  }));
  const placeholders = LEGACY_AUTOMATION_DROP_TABLES.map(() => "?").join(",");
  const indexes = sqlite.query<{ name: string; sql: string | null; tbl_name: string }, string[]>(`
    select name, tbl_name, sql from sqlite_master where type='index' and tbl_name in (${placeholders}) order by tbl_name,name
  `).all(...LEGACY_AUTOMATION_DROP_TABLES).map((row) => ({ name: row.name, table: row.tbl_name, sql: row.sql }));
  return {
    indexes,
    retained: [
      { reason: "live PI heartbeat control/execution audit authority", tables: ["pi_heartbeat_controls", "pi_heartbeat_runs", "pi_heartbeat_events"] },
      { reason: "live report/prompt authorization consumer remains", tables: ["pi_delegations"] },
      { reason: "Issue/Run/Work and PI Action/Approval remain shared authorities", tables: ["issues", "issue_events", "issue_runs", "works", "work_events", "pi_actions", "pi_action_events", "pi_approval_requests"] }
    ],
    tables
  };
}

export function archivePayload(sqlite: Database, dbPath: string, inventory: ReturnType<typeof inventoryFor>) {
  const payload = {
    database_sha256: sha256File(dbPath),
    indexes: inventory.indexes,
    migration_id: LEGACY_AUTOMATION_DROP_MIGRATION_ID,
    source_of_truth: "automation_definitions, automation_runs/events and automation_watches are target-primary; this archive is read-only rollback evidence",
    tables: LEGACY_AUTOMATION_DROP_TABLES.map((table) => ({
      create_sql: schemaSQL(sqlite, "table", table),
      name: table,
      rows: tableExists(sqlite, table) ? orderedRows(sqlite, table) : null
    }))
  };
  return { checksum_sha256: sha256(stableJSON(payload)), payload };
}

export function archiveContentChecksum(payload: ReturnType<typeof archivePayload>["payload"]): string {
  return sha256(stableJSON({ indexes: payload.indexes, migration_id: payload.migration_id, tables: payload.tables }));
}

export function createVerifiedBackup(sqlite: Database, backupPath: string, expectedArchiveChecksum: string) {
  mkdirSync(dirname(backupPath), { recursive: true });
  sqlite.run("vacuum main into ?", [backupPath]);
  const backupHash = sha256File(backupPath);
  const root = mkdtempSync(`${tmpdir()}/xw-p11-09-restore-`);
  const restoredPath = resolve(root, "runner-restored.db");
  try {
    copyFileSync(backupPath, restoredPath);
    const restored = open(restoredPath, true);
    try {
      const restoredInventory = inventoryFor(restored);
      const restoredArchive = archivePayload(restored, restoredPath, restoredInventory);
      const health = databaseHealth(restored);
      if (health.quick_check !== "ok" || health.foreign_key_violations !== 0) {
        throw new Error("isolated backup restore health check failed");
      }
      const restoredContentChecksum = archiveContentChecksum(restoredArchive.payload);
      if (restoredContentChecksum !== expectedArchiveChecksum) {
        throw new Error("isolated backup restore archive checksum mismatch");
      }
      return {
        path: backupPath,
        quick_check: health.quick_check,
        foreign_key_violations: health.foreign_key_violations,
        restore_rehearsal_completed: true,
        restored_archive_checksum_sha256: restoredContentChecksum,
        sha256: backupHash
      };
    } finally {
      restored.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

export function writeAndVerifyArchive(path: string, candidate: ReturnType<typeof archivePayload>) {
  mkdirSync(dirname(path), { recursive: true });
  const archive = {
    archive_sha256: candidate.checksum_sha256,
    contract: LEGACY_AUTOMATION_ARCHIVE_CONTRACT,
    created_at: new Date().toISOString(),
    payload: candidate.payload
  };
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const verification = verifyLegacyAutomationArchive(path);
  return { ...verification, rows: candidate.payload.tables.map((table) => ({ name: table.name, rows: table.rows?.length ?? 0 })) };
}

function orderedRows(sqlite: Database, table: string): Record<string, unknown>[] {
  return sqlite.query<Record<string, unknown>, []>(`select * from ${table} order by rowid`).all();
}

function schemaSQL(sqlite: Database, type: string, name: string): string | null {
  return sqlite.query<{ sql: string | null }, [string, string]>(
    "select sql from sqlite_master where type=? and name=?"
  ).get(type, name)?.sql ?? null;
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}

export function tableExists(sqlite: Database, table: string): boolean {
  return Boolean(sqlite.query("select name from sqlite_master where type='table' and name=?").get(table));
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJSON(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function writeJSON(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
