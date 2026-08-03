import type { Database } from "bun:sqlite";

export type SQLiteObjectUsage = {
  bytes: number;
  name: string;
};

type SQLiteMasterRow = { name: string; type: string };
type TableInfoRow = { name: string };

export function sqliteObjectUsage(
  sqlite: Database,
  names?: string[],
  options: { forceLogicalFallback?: boolean } = {}
): SQLiteObjectUsage[] {
  if (!options.forceLogicalFallback) {
    try {
      const filter = names?.length ? `where name in (${names.map(() => "?").join(",")})` : "";
      return sqlite.query<SQLiteObjectUsage, string[]>(`
        select name, sum(pgsize) as bytes from dbstat
        ${filter} group by name order by bytes desc, name asc
      `).all(...(names ?? [])).map(normalizeUsage);
    } catch {
      // dbstat is an optional SQLite extension and is absent from some Bun builds.
    }
  }

  return logicalTableUsage(sqlite, names);
}

function logicalTableUsage(sqlite: Database, names?: string[]): SQLiteObjectUsage[] {
  const filter = names?.length ? `and name in (${names.map(() => "?").join(",")})` : "";
  const tables = sqlite.query<SQLiteMasterRow, string[]>(`
    select name, type from sqlite_master
    where type='table' and name not like 'sqlite_%' ${filter}
    order by name asc
  `).all(...(names ?? []));

  return tables.map((table) => {
    const identifier = quoteIdentifier(table.name);
    const columns = sqlite.query<TableInfoRow, []>(`pragma table_info(${identifier})`).all();
    const byteExpression = columns.length === 0
      ? "0"
      : columns.map((column) => `coalesce(length(cast(${quoteIdentifier(column.name)} as blob)), 0)`).join(" + ");
    const bytes = sqlite.query<{ bytes: number }, []>(`
      select coalesce(sum(${byteExpression}), 0) as bytes from ${identifier}
    `).get()?.bytes ?? 0;
    return { bytes: Number(bytes), name: table.name };
  }).sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeUsage(row: SQLiteObjectUsage): SQLiteObjectUsage {
  return { bytes: Number(row.bytes), name: String(row.name) };
}
