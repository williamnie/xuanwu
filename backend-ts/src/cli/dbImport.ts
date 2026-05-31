import { Database as SQLiteDatabase, type SQLQueryBindings } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { parseCommandArgs } from "./common.ts";
import {
  SAFE_IMPORT_TABLES,
  commonColumns,
  countRows,
  emptyTableCounts,
  quoteIdentifier,
  tableExists,
  type SafeImportTable,
  type TableCounts
} from "./dbTableUtils.ts";
import type { EnvReader } from "./types.ts";

export const DEFAULT_GO_DB = join("data", "runner.db");
export const DEFAULT_BUN_DB = join("data-bun", "runner.db");
export { SAFE_IMPORT_TABLES, type SafeImportTable, type TableCounts };

type ImportOptions = { sourcePath: string; targetPath?: string };
export type GoDatabaseImportResult = {
  ok: true;
  source: string;
  source_mtime_unchanged: boolean;
  source_readonly: true;
  tables: TableCounts;
  target: string;
  upload_paths_rebased: number;
};

export async function runDbImport(args: string[], env: EnvReader): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing db command");
  if (command === "rehearse-final-migration") {
    const { runFinalMigrationRehearsal } = await import("./dbRehearsal.ts");
    return await runFinalMigrationRehearsal(args.slice(1), env);
  }
  if (command !== "import-go") throw new Error(`unknown db command: ${command}`);
  const { common, values } = parseCommandArgs(args.slice(1), [
    { name: "source" },
    { name: "target" }
  ], env);
  const result = await importGoDatabase({
    sourcePath: clean(values.source) || DEFAULT_GO_DB,
    targetPath: clean(values.target) || undefined
  });
  return common.json ? `${JSON.stringify(result, null, 2)}\n` : formatImportResult(result);
}

export async function importGoDatabase(options: ImportOptions): Promise<GoDatabaseImportResult> {
  ensureDistinctDatabasePaths(options.sourcePath, options.targetPath ?? DEFAULT_BUN_DB);
  const before = await stat(options.sourcePath);
  const source = new SQLiteDatabase(options.sourcePath, { readonly: true, readwrite: false, strict: true });
  try {
    const target = await openDatabase(options.targetPath ? { dbPath: options.targetPath } : {});
    try {
      const tables = copySafeTables(source, target);
      const uploadPathsRebased = rebaseImportedUploadPaths(target, options.sourcePath);
      const after = await stat(options.sourcePath);
      return {
        ok: true,
        source: options.sourcePath,
        source_mtime_unchanged: before.mtimeMs === after.mtimeMs,
        source_readonly: true,
        tables,
        target: target.path,
        upload_paths_rebased: uploadPathsRebased
      };
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
}

function copySafeTables(source: SQLiteDatabase, target: RunnerDatabase): TableCounts {
  const summaries = emptyTableCounts();
  const copy = target.transaction(() => {
    clearSafeTargetTables(target.sqlite);
    for (const table of SAFE_IMPORT_TABLES) summaries[table] = copyTable(source, target.sqlite, table);
  });
  copy.immediate();
  return summaries;
}

function copyTable(
  source: SQLiteDatabase,
  target: SQLiteDatabase,
  table: SafeImportTable
): { source: number; target: number } {
  if (!tableExists(source, table)) return { source: 0, target: countRows(target, table) };
  const sourceCount = countRows(source, table);
  const columns = commonColumns(source, target, table);
  if (sourceCount > 0 && columns.length === 0) throw new Error(`no importable columns for ${table}`);
  if (columns.length > 0) insertRows(source, target, table, columns);
  return { source: sourceCount, target: countRows(target, table) };
}

function insertRows(source: SQLiteDatabase, target: SQLiteDatabase, table: SafeImportTable, columns: string[]): void {
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const tableSql = quoteIdentifier(table);
  const rows = source.query<Record<string, unknown>, []>(`select ${columnSql} from ${tableSql}`).all();
  const insert = target.query(`insert into ${tableSql} (${columnSql}) values (${placeholders})`);
  for (const row of rows) insert.run(...columns.map((column) => sqlValue(row[column])));
}

function sqlValue(value: unknown): SQLQueryBindings {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return null;
}

function ensureDistinctDatabasePaths(sourcePath: string, targetPath: string): void {
  if (resolve(sourcePath) === resolve(targetPath)) {
    throw new Error("source and target database paths must be different");
  }
}

function clearSafeTargetTables(target: SQLiteDatabase): void {
  target.run("delete from pi_memory_items");
  target.run("delete from pi_actions");
  target.run("delete from pi_conversations");
  target.run("delete from project_pi_settings");
  target.run("delete from pi_agents");
  target.run("delete from uploads");
  target.run("delete from app_preferences");
  target.run("delete from nightly_batch_items");
  target.run("delete from nightly_batches");
  target.run("delete from cron_tasks");
  target.run("delete from project_holds");
  target.run("delete from session_command_events");
  target.run("delete from session_turn_references");
  target.run("delete from agent_sessions");
  target.run("delete from issue_runs");
  target.run("delete from issue_events");
  target.run("delete from issues");
  target.run("delete from issue_templates");
  target.run("delete from agent_profiles");
  target.run("delete from projects");
}

function rebaseImportedUploadPaths(target: RunnerDatabase, sourcePath: string): number {
  if (!tableExists(target.sqlite, "uploads")) return 0;
  const sourceDataDir = resolve(join(sourcePath, ".."));
  const targetDataDir = resolve(join(target.path, ".."));
  const sourceUploads = join(sourceDataDir, "uploads");
  const targetUploads = join(targetDataDir, "uploads");
  const rows = target.sqlite.query<{ id: string; storage_path: string }, []>(
    "select id, storage_path from uploads"
  ).all();
  let changed = 0;
  for (const row of rows) {
    if (!row.storage_path.startsWith(sourceUploads)) continue;
    const nextPath = row.storage_path.replace(sourceUploads, targetUploads);
    target.sqlite.run("update uploads set storage_path=? where id=?", [nextPath, row.id]);
    changed += 1;
  }
  return changed;
}

function formatImportResult(result: GoDatabaseImportResult): string {
  const lines = [`imported ${result.source} -> ${result.target}`];
  for (const table of SAFE_IMPORT_TABLES) {
    const counts = result.tables[table];
    lines.push(`${table}: source=${counts.source} target=${counts.target}`);
  }
  lines.push(`source_readonly=${result.source_readonly} source_mtime_unchanged=${result.source_mtime_unchanged}`);
  lines.push(`upload_paths_rebased=${result.upload_paths_rebased}`);
  return `${lines.join("\n")}\n`;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
