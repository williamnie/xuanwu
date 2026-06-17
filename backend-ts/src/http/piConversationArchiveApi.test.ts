import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-archive-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI archived conversations API", () => {
  test("lists archived conversations with cursor pagination", async () => {
    const database = await openFixtureDatabase();
    try {
      insertAgent(database);
      insertConversation(database, { id: "active", title: "Active", status: "active", updatedAt: "2026-06-17T10:00:00Z" });
      insertConversation(database, { id: "archived-new", title: "New", status: "archived", updatedAt: "2026-06-17T09:00:00Z" });
      insertConversation(database, { id: "archived-old", title: "Old", status: "archived", updatedAt: "2026-06-17T08:00:00Z" });
      const router = createDefaultRouter({ database });

      const first = await router.handle(new Request(`${BASE_URL}/api/pi/conversations/archived?page_size=1`));
      const firstBody = await first.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null; total: number };
      const second = await router.handle(new Request(`${BASE_URL}/api/pi/conversations/archived?page_size=1&cursor=${encodeURIComponent(String(firstBody.next_cursor))}`));
      const secondBody = await second.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };

      expect(first.status).toBe(200);
      expect(firstBody.total).toBe(2);
      expect(firstBody.items).toMatchObject([{ session_id: "archived-new", title: "New", archived_at: "2026-06-17T09:00:00Z" }]);
      expect(firstBody.next_cursor).toBe("2026-06-17T09:00:00Z|archived-new");
      expect(second.status).toBe(200);
      expect(secondBody.items).toMatchObject([{ session_id: "archived-old", title: "Old", archived_at: "2026-06-17T08:00:00Z" }]);
      expect(secondBody.next_cursor).toBe(null);
    } finally {
      database.close();
    }
  });

  test("restores an archived conversation and hides it from archived list", async () => {
    const database = await openFixtureDatabase();
    try {
      insertAgent(database);
      insertConversation(database, { id: "archived", title: "Archived", status: "archived", updatedAt: "2026-06-17T09:00:00Z" });
      const router = createDefaultRouter({ database });

      const restored = await router.handle(new Request(`${BASE_URL}/api/pi/conversations/archived/restore`, { method: "POST" }));
      const list = await router.handle(new Request(`${BASE_URL}/api/pi/conversations/archived`));

      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ session_id: "archived", project_id: null });
      expect(await list.json()).toMatchObject({ items: [], next_cursor: null, total: 0 });
    } finally {
      database.close();
    }
  });
});

function insertAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    ["pi-default", "PI Default", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertConversation(
  db: RunnerDatabase,
  input: { id: string; status: string; title: string; updatedAt: string }
): void {
  db.sqlite.run(
    `insert into pi_conversations
      (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, "", "pi-default", input.title, input.status, "", input.id,
      "2026-06-17T07:00:00Z", input.updatedAt]
  );
}
