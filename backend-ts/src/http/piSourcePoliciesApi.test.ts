import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerDatabase } from "../db/database.ts";
import { createProjectPiSettings } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";
import { useTestDatabase } from "../testing/harness.ts";

const BASE_URL = "http://127.0.0.1:3008";
const openFixtureDatabase = useTestDatabase();

describe("PI source policies API", () => {
  test("lists read-only policy layers and redirects retired automation-owned writes", async () => {
    const db = await openFixtureDatabase();
    const router = createDefaultRouter({ database: db });
    const listed = await jsonRequest(router, "/api/pi/source-policies");
    const redirected = await router.handle(new Request(`${BASE_URL}/api/pi/source-policies`, { method: "POST" }));

    expect(listed.layers.map((layer: { scope: string }) => layer.scope)).toEqual([
      "source_profile", "project", "global", "automation"
    ]);
    expect(listed.profiles.map((profile: { id: string }) => profile.id)).toContain("company_chat");
    expect(listed.automations).toEqual([]);
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get("location")).toBe("/api/automations");
  });

  test("exposes project policy overlay from existing project settings", async () => {
    const db = await openFixtureDatabase();
    seedProject(db, "demo");
    createProjectPiSettings(db, { project_id: "demo" });
    const policy = await jsonRequest(createDefaultRouter({ database: db }), "/api/pi/source-policies?project_id=demo");

    expect(policy.project_policy).toMatchObject({
      managed: true,
      issue_policy: { auto_create_triage_issue: true, auto_enqueue: true },
      project_id: "demo"
    });
  });
});

function seedProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<Record<string, any>>;
}
