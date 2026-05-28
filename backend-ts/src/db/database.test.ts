import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";

const tempRoots: string[] = [];

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun SQLite database connection", () => {
  test("creates the state directory and default runner database", async () => {
    const root = await tempPath("codex-runner-bun-db-");
    const stateDir = join(root, "state");
    const connection = await openDatabase({ stateDir });

    try {
      connection.sqlite.run("create table items (name text not null)");
      connection.sqlite.run("insert into items (name) values (?)", ["alpha"]);

      expect(connection.path).toBe(join(stateDir, "runner.db"));
      expect(existsSync(stateDir)).toBe(true);
      expect(existsSync(connection.path)).toBe(true);
      expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "alpha" });
    } finally {
      connection.close();
    }
  });

  test("rejects runtime access to the Go stable database path", async () => {
    await expect(openDatabase({ dbPath: "data/runner.db" })).rejects.toThrow(
      "refusing to open Go stable database for Bun runtime"
    );
  });

  test("opens explicit read-only import database without allowing writes", async () => {
    const root = await tempPath("codex-runner-bun-import-");
    const dataDir = join(root, "data");
    const importPath = join(dataDir, "runner.db");
    await mkdir(dataDir, { recursive: true });
    createFixtureDatabase(importPath);

    const connection = await openDatabase({ readonlyImportPath: importPath });

    try {
      expect(connection.readonly).toBe(true);
      expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "fixture" });
      expect(() => connection.sqlite.run("insert into items (name) values ('write')")).toThrow();
    } finally {
      connection.close();
    }
  });

  test("runs callbacks inside a rollback-capable transaction", async () => {
    const root = await tempPath("codex-runner-bun-tx-");
    const connection = await openDatabase({ stateDir: join(root, "state") });

    try {
      connection.sqlite.run("create table items (name text not null)");
      const insertThenFail = failingInsertTransaction(connection);

      expect(() => insertThenFail("rolled-back")).toThrow("rollback fixture");
      expect(connection.sqlite.query("select count(*) as count from items").get()).toEqual({ count: 0 });
    } finally {
      connection.close();
    }
  });
});

function createFixtureDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.run("create table items (name text not null)");
    db.run("insert into items (name) values ('fixture')");
  } finally {
    db.close();
  }
}

function failingInsertTransaction(connection: RunnerDatabase): (name: string) => void {
  return connection.transaction((name: string) => {
    connection.sqlite.run("insert into items (name) values (?)", [name]);
    throw new Error("rollback fixture");
  });
}
