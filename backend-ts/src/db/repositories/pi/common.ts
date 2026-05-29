import type { RunnerDatabase } from "../../database.ts";

export type Mapper<T> = (row: Record<string, unknown>) => T;
export type PatchInput<T> = Partial<Record<keyof T, unknown>>;
type SQLValue = string | number | boolean | null;

type Query = { args: SQLValue[]; sql: string };

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

export function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

export function integerInput(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export function jsonText(value: unknown, fallback: string): string {
  const text = cleanString(value);
  return text === "" ? fallback : text;
}

export function requireCreateFields(input: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (cleanString(input[field]) === "") throw new Error(`${field} is required`);
  }
}

export function hasPatchValue(input: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined;
}

export function getByID<T>(
  db: RunnerDatabase,
  table: string,
  columns: string,
  id: string,
  mapper: Mapper<T>,
  keyColumn = "id"
): T | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${columns} from ${table} where ${keyColumn}=?`
  ).get(key);
  return row ? mapper(row) : null;
}

export function deleteByID(db: RunnerDatabase, table: string, id: string, keyColumn = "id"): boolean {
  const key = requiredString(id, keyColumn);
  const result = db.sqlite.run(`delete from ${table} where ${keyColumn}=?`, [key]);
  return result.changes > 0;
}

export function listRows<T>(
  db: RunnerDatabase,
  table: string,
  columns: string,
  mapper: Mapper<T>,
  filter: Query = { args: [], sql: "" }
): T[] {
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${columns} from ${table}${filter.sql}`
  ).all(...filter.args).map(mapper);
}

export function buildFilter(filters: Array<[string, string | number | undefined]>, orderBy: string): Query {
  const conditions: string[] = [];
  const args: SQLValue[] = [];
  for (const [condition, value] of filters) {
    const text = typeof value === "number" ? value : cleanString(value);
    if (text === "") continue;
    conditions.push(condition);
    args.push(text);
  }
  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  return { args, sql: `${where} order by ${orderBy}` };
}

export function updateByID<T>(
  db: RunnerDatabase,
  table: string,
  columns: readonly string[],
  id: string,
  input: PatchInput<T>,
  keyColumn = "id"
): void {
  const key = requiredString(id, keyColumn);
  const fields = columns.filter((column) => hasPatchValue(input, column));
  if (fields.length === 0) return;
  const assignments = [...fields.map((field) => `${field}=?`), "updated_at=?"].join(", ");
  const values = fields.map((field) => sqliteValue(input[field as keyof T]));
  db.sqlite.run(`update ${table} set ${assignments} where ${keyColumn}=?`, [...values, now(), key]);
}

function sqliteValue(value: unknown): SQLValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return cleanString(value);
}
