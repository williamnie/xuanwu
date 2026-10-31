import { Database } from "bun:sqlite";

export function metadata(db: Database, key: string): string {
  return db.query<{ value: string }, [string]>("select value from metadata where key=?").get(key)?.value ?? "";
}

export function metadataNumber(db: Database, key: string): number {
  const value = Number(metadata(db, key));
  return Number.isFinite(value) ? value : 0;
}

export function setMetadata(db: Database, key: string, value: string): void {
  db.query("insert into metadata(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run(key, value);
}

export function scalarNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  const value = Number(Object.values(row)[0]);
  return Number.isFinite(value) ? value : 0;
}

export function scalarText(db: Database, sql: string): string {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}
