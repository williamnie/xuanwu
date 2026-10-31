import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, WRITER_BUSY_TIMEOUT_MS } from "../db/database.ts";
import { useDatabaseCleanup, useTempDirs } from "../testing/harness.ts";
import { openCoreDatabase } from "./coreDatabase.ts";

const tempDir = useTempDirs("xuanwu-core-startup-");
const trackDatabase = useDatabaseCleanup();

async function seededOptions() {
  const stateDir = await tempDir();
  const dbPath = join(stateDir, "runner.db");
  const database = await openDatabase({ dbPath, stateDir });
  database.close();
  return { dbPath, stateDir };
}

describe("Core database startup", () => {
  test("yields and retries a temporary writer lock without increasing runtime lock waits", async () => {
    const options = await seededOptions();
    const blocker = new Database(options.dbPath);
    blocker.run("begin immediate");
    let locked = true;
    const release = setTimeout(() => {
      blocker.run("rollback");
      locked = false;
    }, WRITER_BUSY_TIMEOUT_MS + 50);
    try {
      const database = trackDatabase(await openCoreDatabase(options, { windowMs: 2_000 }));
      expect(locked).toBe(false);
      expect(database.sqlite.query("pragma busy_timeout").get()).toEqual({ timeout: WRITER_BUSY_TIMEOUT_MS });
      expect(database.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
    } finally {
      clearTimeout(release);
      if (locked) blocker.run("rollback");
      blocker.close();
    }
  });

  test("stops retrying a persistent lock and can reopen after the lock is released", async () => {
    const options = await seededOptions();
    const blocker = new Database(options.dbPath);
    blocker.run("begin immediate");
    try {
      await expect(openCoreDatabase(options, { windowMs: 300, delayMs: 10 }))
        .rejects.toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      blocker.run("rollback");
      blocker.close();
    }
    const database = trackDatabase(await openCoreDatabase(options));
    expect(database.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
  });

  test("fails immediately for non-contention errors", async () => {
    const stateDir = await tempDir();
    const dbPath = join(stateDir, "invalid.db");
    await writeFile(dbPath, "not a sqlite database");
    await expect(openCoreDatabase({ dbPath, stateDir })).rejects.toMatchObject({ code: "SQLITE_NOTADB" });
  });
});
