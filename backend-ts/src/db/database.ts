import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildRunnerPaths } from "../config/paths.ts";
import { ensureDefaultPiAgent } from "./defaultPiAgent.ts";
import { runMigrations } from "./migrations.ts";

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
  if (!target.readonly) await createRuntimeDirectories(target.stateDir, target.path);

  const sqlite = new SQLiteDatabase(target.path, {
    create: !target.readonly,
    readonly: target.readonly,
    readwrite: !target.readonly,
    strict: true
  });
  sqlite.run("pragma foreign_keys = on");
  if (!target.readonly) {
    runMigrations(sqlite);
    ensureDefaultPiAgent({ readonly: false, sqlite });
  }

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

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizedSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}
