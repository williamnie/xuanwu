import { Database as SQLiteDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_BUN_DB, DEFAULT_GO_DB, importGoDatabase } from "./dbImport.ts";
import { parseCommandArgs } from "./common.ts";
import {
  SAFE_IMPORT_TABLES,
  commonColumns,
  countRows,
  quoteIdentifier,
  tableExists,
  type SafeImportTable
} from "./dbTableUtils.ts";
import type { EnvReader } from "./types.ts";

const DEFAULT_BACKUP_DIR = join("data", "backups", "p08-cutover");

type TableReconciliation = {
  match: boolean;
  source_count: number;
  source_hash: string;
  target_count: number;
  target_hash: string;
};

export type RehearsalOptions = { backupDir?: string; bunDbPath: string; goDbPath: string };

export type FinalMigrationRehearsalResult = {
  ok: true;
  backup_dir: string;
  backups: { bun_db: string; go_db: string };
  rehearsal: { target_db: string; target_dir: string };
  reconciliation: { all_match: boolean; tables: Record<SafeImportTable, TableReconciliation> };
  restore_commands: { bun_db: string; go_db: string };
};

export async function runFinalMigrationRehearsal(args: string[], env: EnvReader): Promise<string> {
  const { common, values } = parseCommandArgs(args, [
    { name: "backup-dir" },
    { name: "bun-db" },
    { name: "go-db" }
  ], env);
  const result = await rehearseFinalMigration({
    backupDir: clean(values["backup-dir"]) || DEFAULT_BACKUP_DIR,
    bunDbPath: clean(values["bun-db"]) || DEFAULT_BUN_DB,
    goDbPath: clean(values["go-db"]) || DEFAULT_GO_DB
  });
  return common.json ? `${JSON.stringify(result, null, 2)}\n` : formatRehearsalResult(result);
}

export async function rehearseFinalMigration(options: RehearsalOptions): Promise<FinalMigrationRehearsalResult> {
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const targetDir = join(backupDir, "rehearsal");
  const paths = {
    bunBackup: join(backupDir, "bun-runner.db"),
    goBackup: join(backupDir, "go-runner.db"),
    targetDb: join(targetDir, "runner.db")
  };
  let stage = "prepare backup directory";
  try {
    await mkdir(targetDir, { recursive: true });
    stage = "backup Go database";
    await backupSqliteDatabase(options.goDbPath, paths.goBackup);
    stage = "backup Bun database";
    await backupSqliteDatabase(options.bunDbPath, paths.bunBackup);
    stage = "prepare rehearsal target";
    await prepareRehearsalTarget(options, paths.targetDb, paths.bunBackup);
    stage = "import Go data into rehearsal target";
    await importGoDatabase({ sourcePath: paths.goBackup, targetPath: paths.targetDb });
    stage = "reconcile row counts and hashes";
    return checkedResult(backupDir, targetDir, paths, options, reconcileDatabases(paths.goBackup, paths.targetDb));
  } catch (error) {
    const diagnostics = await writeFailureDiagnostics(backupDir, stage, options, error);
    throw new Error(`final migration rehearsal failed during ${stage}; diagnostics preserved at ${diagnostics}: ${errorMessage(error)}`);
  }
}

async function prepareRehearsalTarget(
  options: RehearsalOptions,
  targetDb: string,
  bunBackup: string
): Promise<void> {
  if (samePath(options.goDbPath, targetDb) || samePath(options.bunDbPath, targetDb)) {
    throw new Error("rehearsal target must not be a live database path");
  }
  await copyFile(bunBackup, targetDb);
}

async function backupSqliteDatabase(sourcePath: string, backupPath: string): Promise<void> {
  if (samePath(sourcePath, backupPath)) throw new Error("backup path must differ from source database path");
  await mkdir(dirname(backupPath), { recursive: true });
  const source = new SQLiteDatabase(sourcePath, { readonly: true, readwrite: false, strict: true });
  try {
    await writeFile(backupPath, source.serialize(), { mode: 0o600 });
    await chmod(backupPath, 0o600);
  } finally {
    source.close();
  }
}

function reconcileDatabases(sourcePath: string, targetPath: string): FinalMigrationRehearsalResult["reconciliation"] {
  const source = new SQLiteDatabase(sourcePath, { readonly: true, readwrite: false, strict: true });
  const target = new SQLiteDatabase(targetPath, { readonly: true, readwrite: false, strict: true });
  try {
    const summaries = SAFE_IMPORT_TABLES.map((table) => [table, reconcileTable(source, target, table)]);
    const tables = Object.fromEntries(summaries) as Record<SafeImportTable, TableReconciliation>;
    return { all_match: Object.values(tables).every((summary) => summary.match), tables };
  } finally {
    target.close();
    source.close();
  }
}

function reconcileTable(source: SQLiteDatabase, target: SQLiteDatabase, table: SafeImportTable): TableReconciliation {
  const sourceCount = tableExists(source, table) ? countRows(source, table) : 0;
  const targetCount = tableExists(target, table) ? countRows(target, table) : 0;
  const columns = sharedColumns(source, target, table);
  const sourceHash = tableHash(source, table, columns);
  const targetHash = tableHash(target, table, columns);
  return {
    match: sourceCount === targetCount && sourceHash === targetHash,
    source_count: sourceCount,
    source_hash: sourceHash,
    target_count: targetCount,
    target_hash: targetHash
  };
}

function sharedColumns(source: SQLiteDatabase, target: SQLiteDatabase, table: SafeImportTable): string[] {
  if (!tableExists(source, table) || !tableExists(target, table)) return [];
  return commonColumns(source, target, table);
}

function tableHash(db: SQLiteDatabase, table: SafeImportTable, columns: string[]): string {
  if (!tableExists(db, table) || columns.length === 0) return sha256(JSON.stringify({ columns, rows: [] }));
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const orderSql = preferredOrderColumns(columns).map(quoteIdentifier).join(", ");
  const rows = db.query<Record<string, unknown>, []>(
    `select ${columnSql} from ${quoteIdentifier(table)} order by ${orderSql}`
  ).all();
  return sha256(JSON.stringify({ columns, rows: rows.map((row) => columns.map((column) => row[column] ?? null)) }));
}

function checkedResult(
  backupDir: string,
  targetDir: string,
  paths: { bunBackup: string; goBackup: string; targetDb: string },
  options: RehearsalOptions,
  reconciliation: FinalMigrationRehearsalResult["reconciliation"]
): FinalMigrationRehearsalResult {
  if (!reconciliation.all_match) throw new Error("row count/hash reconciliation mismatch");
  return {
    ok: true,
    backup_dir: backupDir,
    backups: { bun_db: paths.bunBackup, go_db: paths.goBackup },
    rehearsal: { target_db: paths.targetDb, target_dir: targetDir },
    reconciliation,
    restore_commands: {
      bun_db: `cp ${shellQuote(paths.bunBackup)} ${shellQuote(options.bunDbPath)}`,
      go_db: `cp ${shellQuote(paths.goBackup)} ${shellQuote(options.goDbPath)}`
    }
  };
}

function formatRehearsalResult(result: FinalMigrationRehearsalResult): string {
  const lines = [
    "final migration rehearsal OK",
    `backup_dir=${result.backup_dir}`,
    `go_backup=${result.backups.go_db}`,
    `bun_backup=${result.backups.bun_db}`,
    `rehearsal_target=${result.rehearsal.target_db}`,
    `restore_go=${result.restore_commands.go_db}`,
    `restore_bun=${result.restore_commands.bun_db}`,
    `reconciliation_all_match=${result.reconciliation.all_match}`
  ];
  for (const table of SAFE_IMPORT_TABLES) lines.push(formatTable(table, result.reconciliation.tables[table]));
  return `${lines.join("\n")}\n`;
}

function formatTable(table: SafeImportTable, summary: TableReconciliation): string {
  return `${table}: source=${summary.source_count} target=${summary.target_count} match=${summary.match} hash=${summary.target_hash}`;
}

async function writeFailureDiagnostics(backupDir: string, stage: string, options: RehearsalOptions, error: unknown): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const path = join(backupDir, "diagnostics.json");
  await writeFile(path, `${JSON.stringify({ error: errorMessage(error), options, stage }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preferredOrderColumns(columns: string[]): string[] {
  return columns.includes("id") ? ["id"] : columns;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
