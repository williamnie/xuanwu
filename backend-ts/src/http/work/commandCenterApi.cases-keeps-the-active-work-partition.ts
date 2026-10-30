import { expect, test } from "bun:test";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./commandCenterApi.testFixture.ts";

export function registerKeepsTheActiveWorkPartitionCases(testScope: TestFixture) {
  const { BASE_URL, SOURCE_TIME, fixtureDatabase } = testScope;
  test("keeps the active Work partition bounded on a large library", async () => {
      const db = await fixtureDatabase();
      const insert = db.sqlite.prepare(`
        insert into issues (project_id, title, description, status, priority, created_at, updated_at)
        values ('demo', ?, '', 'todo', ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) {
          insert.run(`Large Work ${index}`, index, SOURCE_TIME, SOURCE_TIME);
        }
      }).immediate();
      const router = createDefaultRouter({ database: db });
  
      const startedAt = performance.now();
      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=active_work&limit=10`
      ));
      const elapsedMs = performance.now() - startedAt;
      const body = await response.json() as Record<string, any>;
  
      expect(response.status).toBe(200);
      expect(body.sections.active_work).toMatchObject({
        counts: { returned: 10, total: 12_000 },
        status: "ok"
      });
      expect(body.sections.active_work.items).toHaveLength(10);
      expect(elapsedMs).toBeLessThan(2_000);
    });
  
  test("rejects unbounded limits and unknown sections with actionable errors", async () => {
      const db = await fixtureDatabase();
      const router = createDefaultRouter({ database: db });
      const limit = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?limit=26`));
      const section = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=unknown`));
      expect(limit.status).toBe(400);
      expect(await limit.json()).toEqual({ code: "invalid_limit", message: "limit must be an integer from 1 to 25" });
      expect(section.status).toBe(400);
      expect(await section.json()).toEqual({ code: "invalid_section", message: "unknown Command Center section: unknown" });
    });
}
