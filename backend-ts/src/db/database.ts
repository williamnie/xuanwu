import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { buildRunnerPaths } from "../config/paths.ts";

const GO_STABLE_DB_PATH = join("data", "runner.db");

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
  if (!target.readonly && isGoStableDatabasePath(target.path)) throw goStableDatabaseError();
  if (!target.readonly) await createRuntimeDirectories(target.stateDir, target.path);

  const sqlite = new SQLiteDatabase(target.path, {
    create: !target.readonly,
    readonly: target.readonly,
    readwrite: !target.readonly,
    strict: true
  });
  sqlite.run("pragma foreign_keys = on");

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
  const suffix = normalizedSlashes(GO_STABLE_DB_PATH);
  const normalized = normalizedSlashes(normalize(path));
  const absolute = normalizedSlashes(normalize(resolve(path)));
  return normalized === suffix || normalized.endsWith(`/${suffix}`) || absolute.endsWith(`/${suffix}`);
}

function goStableDatabaseError(): Error {
  return new Error("refusing to open Go stable database for Bun runtime");
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizedSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}
