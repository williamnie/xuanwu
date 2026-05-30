import { Database as SQLiteDatabase } from "bun:sqlite";

export const SAFE_IMPORT_TABLES = [
  "projects",
  "agent_profiles",
  "issue_templates",
  "issues",
  "issue_events",
  "issue_runs"
] as const;

export type SafeImportTable = typeof SAFE_IMPORT_TABLES[number];
export type TableCounts = Record<SafeImportTable, { source: number; target: number }>;

export function commonColumns(source: SQLiteDatabase, target: SQLiteDatabase, table: SafeImportTable): string[] {
  const sourceColumns = new Set(columnNames(source, table));
  return columnNames(target, table).filter((column) => sourceColumns.has(column));
}

export function tableExists(db: SQLiteDatabase, table: SafeImportTable): boolean {
  const row = db.query<{ count: number }, [string]>(
    "select count(*) as count from sqlite_master where type='table' and name=?"
  ).get(table);
  return (row?.count ?? 0) > 0;
}

export function countRows(db: SQLiteDatabase, table: SafeImportTable): number {
  const row = db.query<{ count: number }, []>(`select count(*) as count from ${quoteIdentifier(table)}`).get();
  return row?.count ?? 0;
}

export function emptyTableCounts(): TableCounts {
  return Object.fromEntries(SAFE_IMPORT_TABLES.map((table) => [table, { source: 0, target: 0 }])) as TableCounts;
}

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid SQL identifier: ${value}`);
  return `"${value}"`;
}

function columnNames(db: SQLiteDatabase, table: SafeImportTable): string[] {
  return db.query<{ name: string }, []>(`pragma table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}
