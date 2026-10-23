import type { RunnerDatabase } from "./database.ts";

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}
