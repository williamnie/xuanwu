import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildPiMemoryPromptContext } from "../pi/memoryContext.ts";
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

  test("supports typed manual memory with pin and forget aliases plus citation metadata", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/memory", "POST", {
        id: "typed-memory",
        memory_type: "project",
        layer: "long_term",
        scope: "project",
        scope_id: "demo",
        kind: "project_policy",
        content: "Run focused verification before marking runner issues done",
        source_type: "manual",
        source_id: "settings-memory-form",
        citation_type: "inbox",
        citation_id: "inbox-599",
        citation_label: "PI Assistant V2 P08.01",
        citation_url: "https://example.invalid/inbox/599",
        confidence: "high"
      });
      const pinned = await request(router, "/api/pi/memory/typed-memory/pin", "POST", {});
      const updated = await request(router, "/api/pi/memory/typed-memory", "PATCH", {
        memory_type: "skill",
        layer: "working",
        citation_label: "Skill digest review"
      });
      const beforeForget = buildPiMemoryPromptContext(database, { projectID: "demo" });
      const forgot = await request(router, "/api/pi/memory/typed-memory/forget", "POST", {});
      const listAfterForget = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&status=active`
      ));
      const afterForget = buildPiMemoryPromptContext(database, { projectID: "demo" });

      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "typed-memory",
        memory_type: "project",
        layer: "long_term",
        source_type: "manual",
        source_id: "settings-memory-form",
        citation_type: "inbox",
        citation_id: "inbox-599",
        citation_label: "PI Assistant V2 P08.01",
        citation_url: "https://example.invalid/inbox/599"
      });
      expect(pinned.status).toBe(200);
      expect(await pinned.json()).toMatchObject({ id: "typed-memory", pinned: 1 });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        id: "typed-memory",
        memory_type: "skill",
        layer: "working",
        citation_label: "Skill digest review",
        pinned: 1
      });
      expect(beforeForget).toContain("Run focused verification before marking runner issues done");
      expect(forgot.status).toBe(200);
      expect(await forgot.json()).toEqual({ forgotten: true });
      expect(await listAfterForget.json()).toEqual([]);
      expect(afterForget).not.toContain("Run focused verification before marking runner issues done");
      expect(afterForget).not.toContain("typed-memory");
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

  test("creates candidates disabled by default and approves them as active memory", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/memory/candidates", "POST", {
        id: "candidate-2",
        scope: "project",
        scope_id: "demo",
        kind: "session_outcome",
        content: "Verify before marking done",
        source_type: "pi.conversation",
        source_id: "conv-review",
        confidence: "low",
        disabled: false
      });
      const activeBeforeApprove = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&status=active`
      ));
      const candidates = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&status=candidate`
      ));
      const approved = await request(router, "/api/pi/memory/candidate-2/approve", "POST", {});
      const activeAfterApprove = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&status=active`
      ));

      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        confidence: "low",
        disabled: 1,
        source_id: "conv-review",
        source_type: "pi.conversation"
      });
      expect(await activeBeforeApprove.json()).toEqual([]);
      expect((await candidates.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["candidate-2"]);
      expect(await approved.json()).toMatchObject({
        confidence: "low",
        disabled: 0,
        source_id: "conv-review",
        source_type: "pi.conversation"
      });
      expect((await activeAfterApprove.json() as Array<Record<string, unknown>>).map((item) => item.id))
        .toEqual(["candidate-2"]);
    } finally {
      database.close();
    }
  });

  test("covers candidate write, manual promote, and prompt injection as one review chain", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/memory/candidates", "POST", {
        id: "candidate-chain",
        scope: "project",
        scope_id: "demo",
        kind: "project_policy",
        content: "Runner issues must run focused verification before done",
        source_type: "pi.conversation",
        source_id: "conv-chain",
        confidence: "medium"
      });
      const beforePromote = buildPiMemoryPromptContext(database, { projectID: "demo" });
      const promoted = await request(router, "/api/pi/memory/candidate-chain/promote", "POST", {});
      const afterPromote = buildPiMemoryPromptContext(database, { projectID: "demo" });

      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ disabled: 1, source_id: "conv-chain" });
      expect(beforePromote).not.toContain("Runner issues must run focused verification before done");
      expect(await promoted.json()).toMatchObject({ disabled: 0 });
      expect(afterPromote).toContain("Runner issues must run focused verification before done");
      expect(afterPromote).toContain("pi_memory_items/candidate-chain");
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
