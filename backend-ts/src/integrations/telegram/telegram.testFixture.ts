import { afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { openDatabase } from "../../db/database.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  function tableCount(database: Awaited<ReturnType<typeof openDatabase>>, table: string): number {
    return database.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
  }
  return { trackDatabase, roots, tableCount };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
