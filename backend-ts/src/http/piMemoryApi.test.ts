import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-memory-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI memory API", () => {
  test("performs memory CRUD through HTTP and can list candidates separately", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/memory", "POST", {
        id: "mem-1",
        scope: "project",
        scope_id: "demo",
        kind: "preference",
        content: "Prefer minimal patches",
        source_type: "test",
        confidence: "high"
      });
      const listActive = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&disabled=0`
      ));
      const patched = await request(router, "/api/pi/memory/mem-1", "PATCH", {
        disabled: true,
        pinned: true
      });
      const activeAfterPatch = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&disabled=0`
      ));
      const candidates = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&disabled=1`
      ));
      const deleted = await router.handle(new Request(`${BASE_URL}/api/pi/memory/mem-1`, { method: "DELETE" }));

      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "mem-1",
        scope: "project",
        scope_id: "demo",
        kind: "preference",
        content: "Prefer minimal patches",
        source_type: "test",
        confidence: "high",
        pinned: 0,
        disabled: 0
      });
      expect(listActive.status).toBe(200);
      expect((await listActive.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["mem-1"]);
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ id: "mem-1", disabled: 1, pinned: 1 });
      expect(await activeAfterPatch.json()).toEqual([]);
      expect((await candidates.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["mem-1"]);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
    } finally {
      database.close();
    }
  });

  test("promotes and disables memory candidates through explicit review actions", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/memory", "POST", {
        id: "candidate-1",
        scope: "project",
        scope_id: "demo",
        kind: "project_policy",
        content: "Keep patches narrow",
        disabled: true,
        confidence: "medium"
      });

      const promoted = await request(router, "/api/pi/memory/candidate-1/promote", "POST", {});
      const disabled = await request(router, "/api/pi/memory/candidate-1/disable", "POST", {});
      const edited = await request(router, "/api/pi/memory/candidate-1", "PATCH", {
        content: "Keep patches narrow and verified",
        confidence: "high"
      });

      expect(promoted.status).toBe(200);
      expect(await promoted.json()).toMatchObject({ id: "candidate-1", disabled: 0 });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ id: "candidate-1", disabled: 1 });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({
        content: "Keep patches narrow and verified",
        confidence: "high",
        disabled: 1
      });
    } finally {
      database.close();
    }
  });

  test("rejects memory writes that contain high-sensitive secrets", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const response = await request(router, "/api/pi/memory", "POST", {
        id: "secret-memory",
        scope: "project",
        scope_id: "demo",
        kind: "provider_runtime",
        content: "OPENAI_API_KEY=fixture-secret should not be stored"
      });
      const list = await router.handle(new Request(`${BASE_URL}/api/pi/memory?scope=project&scope_id=demo`));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "memory content contains sensitive data" });
      expect(await list.json()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function request(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method: string,
  body: Record<string, unknown>
) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}
