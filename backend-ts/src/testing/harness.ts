import { afterEach } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";

/** Shared test scaffolding: per-test temp state, row seeding and an in-process HTTP client. */

export const FIXTURE_TIME = "2026-01-01T00:00:00Z";

/** Returns a factory for temp directories that are removed after every test of the calling file. */
export function useTempDirs(prefix = "xuanwu-test-"): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}

/** Returns a factory for migrated databases that are closed and deleted after every test. */
export function useTestDatabase(prefix = "xuanwu-test-db-"): () => Promise<RunnerDatabase> {
  const tempDir = useTempDirs(prefix);
  const open: RunnerDatabase[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });
  return async () => {
    const db = await openDatabase({ stateDir: join(await tempDir(), "state") });
    open.push(db);
    return db;
  };
}

export function insertRow(db: RunnerDatabase, table: string, values: Record<string, SQLQueryBindings>): number {
  const columns = Object.keys(values);
  db.sqlite.run(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(values)
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

export function insertProject(db: RunnerDatabase, id = "demo", values: Record<string, SQLQueryBindings> = {}): void {
  insertRow(db, "projects", { id, name: id, cwd: `/tmp/${id}`, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME, ...values });
}

export function insertIssue(db: RunnerDatabase, values: Record<string, SQLQueryBindings> = {}): number {
  return insertRow(db, "issues", {
    project_id: "demo", title: "Issue", status: "triage", created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME, ...values
  });
}

export type ApiResponse<T = any> = { body: T; headers: Headers; status: number };

/** Drives a router in-process; JSON bodies are encoded and decoded, other bodies come back as text. */
export function apiClient(router: { handle(request: Request): Promise<Response> | Response }, base = "http://127.0.0.1:3008") {
  const send = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> => {
    const response = await router.handle(new Request(new URL(path, base).href, {
      method,
      ...(body === undefined ? { headers } : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })
    }));
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
    return { body: parsed as T, headers: response.headers, status: response.status };
  };
  return {
    delete: <T = any>(path: string, body?: unknown) => send<T>("DELETE", path, body),
    get: <T = any>(path: string, headers?: Record<string, string>) => send<T>("GET", path, undefined, headers),
    patch: <T = any>(path: string, body: unknown = {}) => send<T>("PATCH", path, body),
    post: <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => send<T>("POST", path, body, headers),
    put: <T = any>(path: string, body: unknown = {}) => send<T>("PUT", path, body),
    raw: (path: string, init?: RequestInit) => router.handle(new Request(new URL(path, base).href, init))
  };
}

/** Polls until `check` returns a truthy value. */
export async function waitFor<T>(check: () => T | Promise<T>, message = "condition timed out", attempts = 100, intervalMs = 10): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(message);
}
