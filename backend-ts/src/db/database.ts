import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { buildRunnerPaths } from "../config/paths.ts";
import { runMigrations } from "./migrations.ts";

const GO_STABLE_DB_PATHS = [join("data", "runner.db"), join("data", "app.db")];
const ALLOW_GO_STABLE_DB_ENV = "CODEX_RUNNER_BUN_ALLOW_GO_STABLE_DB";

type OpenDatabaseOptions = {
  dbPath?: string;
  readonlyImportPath?: string;
  stateDir?: string;
};

type TransactionRunner<A extends any[], T> = {
  (...args: A): T;
  deferred(...args: A): T;
  exclusive(...args: A): T;
  immediate(...args: A): T;
};

export type RunnerDatabase = {
  close(): void;
  path: string;
  readonly: boolean;
  sqlite: SQLiteDatabase;
  transaction<A extends any[], T>(inside: (...args: A) => T): TransactionRunner<A, T>;
};

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<RunnerDatabase> {
  const target = resolveDatabaseTarget(options);
  if (!target.readonly && isGoStableDatabasePath(target.path) && !allowsGoStableDatabase()) throw goStableDatabaseError();
  if (!target.readonly) await createRuntimeDirectories(target.stateDir, target.path);

  const sqlite = new SQLiteDatabase(target.path, {
    create: !target.readonly,
    readonly: target.readonly,
    readwrite: !target.readonly,
    strict: true
  });
  sqlite.run("pragma foreign_keys = on");
  if (!target.readonly) runMigrations(sqlite);

  return {
    path: target.path,
    readonly: target.readonly,
    sqlite,
    close: () => sqlite.close(),
    transaction: (inside) => sqlite.transaction(inside)
  };
}

type DatabaseTarget = { path: string; readonly: boolean; stateDir: string };

function resolveDatabaseTarget(options: OpenDatabaseOptions): DatabaseTarget {
  const importPath = cleanPath(options.readonlyImportPath);
  if (importPath) return { path: importPath, readonly: true, stateDir: dirname(importPath) };
  const paths = buildRunnerPaths({ dbPath: options.dbPath, stateDir: options.stateDir });
  return { path: paths.dbPath, readonly: false, stateDir: paths.stateDir };
}

async function createRuntimeDirectories(stateDir: string, dbPath: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await mkdir(dirname(dbPath), { recursive: true });
}

function isGoStableDatabasePath(path: string): boolean {
  const normalized = normalizedSlashes(normalize(path));
  const absolute = normalizedSlashes(normalize(resolve(path)));
  return GO_STABLE_DB_PATHS.some((item) => pathMatchesSuffix(normalized, item) || pathMatchesSuffix(absolute, item));
}

function pathMatchesSuffix(path: string, suffixPath: string): boolean {
  const suffix = normalizedSlashes(suffixPath);
  return path === suffix || path.endsWith(`/${suffix}`);
}

function allowsGoStableDatabase(): boolean {
  return ["1", "true", "yes"].includes((Bun.env[ALLOW_GO_STABLE_DB_ENV] ?? "").trim().toLowerCase());
}

function goStableDatabaseError(): Error {
  return new Error(`refusing to open Go stable database for Bun runtime without ${ALLOW_GO_STABLE_DB_ENV}=1`);
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizedSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}
