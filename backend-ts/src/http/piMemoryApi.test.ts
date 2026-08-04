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
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-memory-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI reusable memory API", () => {
  test("creates active memory and updates the same stable key instead of appending", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const first = await request(router, "/api/pi/memory", "POST", {
        id: "mem-first",
        memory_key: "project.patch-policy",
        memory_type: "project",
        layer: "long_term",
        scope: "project",
        scope_id: "demo",
        kind: "project_preference",
        content: "Prefer minimal patches",
        source_type: "manual",
        source_id: "settings-memory-form",
        confidence: "high"
      });
      const second = await request(router, "/api/pi/memory", "POST", {
        id: "mem-duplicate",
        memory_key: "project.patch-policy",
        memory_type: "project",
        layer: "long_term",
        scope: "project",
        scope_id: "demo",
        kind: "project_preference",
        content: "Prefer minimal, verified patches",
        source_type: "manual",
        source_id: "settings-memory-form",
        confidence: "high"
      });
      const list = await router.handle(new Request(
        `${BASE_URL}/api/pi/memory?scope=project&scope_id=demo&status=active`
      ));

      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({
        disabled: 0,
        id: "mem-first",
        memory_key: "project.patch-policy",
        occurrence_count: 1
      });
      expect(second.status).toBe(201);
      expect(await second.json()).toMatchObject({
        content: "Prefer minimal, verified patches",
        disabled: 0,
        id: "mem-first",
        memory_key: "project.patch-policy",
        occurrence_count: 2
      });
      expect(await list.json()).toEqual([
        expect.objectContaining({ id: "mem-first", occurrence_count: 2 })
      ]);
    } finally {
      database.close();
    }
  });

  test("supports edit, pin, disable, enable, and forget without a review queue", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await createResolution(router, "typed-memory");
      const pinned = await request(router, "/api/pi/memory/typed-memory/pin", "POST", {});
      const disabled = await request(router, "/api/pi/memory/typed-memory/disable", "POST", {});
      const enabled = await request(router, "/api/pi/memory/typed-memory/enable", "POST", {});
      const edited = await request(router, "/api/pi/memory/typed-memory", "PATCH", {
        citation_label: "Verified incident review",
        content: "根因是仅查看 Run 叙述；修复并复验 completion gate、Evidence 和 Handoff。"
      });
      const beforeForget = buildPiMemoryPromptContext(database, { projectID: "demo" });
      const forgot = await request(router, "/api/pi/memory/typed-memory/forget", "POST", {});

      expect(await pinned.json()).toMatchObject({ id: "typed-memory", pinned: 1 });
      expect(await disabled.json()).toMatchObject({ disabled: 1 });
      expect(await enabled.json()).toMatchObject({ disabled: 0 });
      expect(await edited.json()).toMatchObject({
        citation_label: "Verified incident review",
        disabled: 0,
        pinned: 1
      });
      expect(beforeForget).toContain("修复并复验 completion gate、Evidence 和 Handoff");
      expect(await forgot.json()).toEqual({ forgotten: true });
      expect(buildPiMemoryPromptContext(database, { projectID: "demo" })).not.toContain("typed-memory");
    } finally {
      database.close();
    }
  });

  test("retires candidate creation, digest, approve, and promote review endpoints", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const responses = await Promise.all([
        request(router, "/api/pi/memory/candidates", "POST", {
          memory_key: "retired.candidate",
          scope: "project",
          scope_id: "demo",
          kind: "decision",
          content: "Should never be stored"
        }),
        router.handle(new Request(`${BASE_URL}/api/pi/memory/digest`)),
        request(router, "/api/pi/memory/missing/approve", "POST", {}),
        request(router, "/api/pi/memory/missing/promote", "POST", {})
      ]);

      expect(responses.map((response) => response.status)).toEqual([410, 410, 410, 410]);
      expect(await responses[0]!.json()).toEqual({
        message: "memory review queue has been retired; reusable memory is automatic"
      });
      expect(await router.handle(new Request(`${BASE_URL}/api/pi/memory`)).then((response) => response.json())).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rejects transient Issue status and non-reusable kinds but keeps root-cause treatment", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const status = await request(router, "/api/pi/memory", "POST", {
        memory_key: "issue.785.status",
        scope: "project",
        scope_id: "demo",
        kind: "decision",
        content: "当前 Issue #785 failed，等待人工处理。"
      });
      const observation = await request(router, "/api/pi/memory", "POST", {
        memory_key: "manager.summary",
        scope: "project",
        scope_id: "demo",
        kind: "project_observation",
        content: "全部终态，没有未完成 Work"
      });
      const resolution = await request(router, "/api/pi/memory", "POST", {
        memory_key: "issue.785.completion-gate",
        scope: "project",
        scope_id: "demo",
        kind: "resolution",
        content: "Issue #785 failed 的根因是只看 Run 叙述；修复方式是复验 Evidence、Handoff 和 completion gate。"
      });

      expect(status.status).toBe(400);
      expect(await status.json()).toEqual({ message: "current Work/Run/Issue status snapshots are not memory" });
      expect(observation.status).toBe(400);
      expect(await observation.json()).toEqual({ message: "memory kind is not reusable" });
      expect(resolution.status).toBe(201);
      expect(await resolution.json()).toMatchObject({ disabled: 0, kind: "resolution" });
      const prompt = buildPiMemoryPromptContext(database, { projectID: "demo" });
      expect(prompt).toContain("Issue #785 failed 的根因");
      expect(prompt).toContain("always query authoritative tools for current state");
    } finally {
      database.close();
    }
  });

  test("batch forget removes disabled legacy garbage without promoting it", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await createResolution(router, "garbage-row");
      await request(router, "/api/pi/memory/garbage-row/disable", "POST", {});
      const forgotten = await request(router, "/api/pi/memory/batch", "POST", {
        action: "forget",
        ids: ["garbage-row"]
      });
      const obsoletePromote = await request(router, "/api/pi/memory/batch", "POST", {
        action: "promote",
        ids: ["garbage-row"]
      });

      expect(await forgotten.json()).toEqual({ action: "forget", forgotten: ["garbage-row"], skipped: [] });
      expect(obsoletePromote.status).toBe(400);
      expect(await router.handle(new Request(`${BASE_URL}/api/pi/memory`)).then((response) => response.json())).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rejects memory writes that contain high-sensitive secrets", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const response = await request(router, "/api/pi/memory", "POST", {
        memory_key: "project.provider-secret",
        scope: "project",
        scope_id: "demo",
        kind: "constraint",
        content: "OPENAI_API_KEY=fixture-secret should not be stored"
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "memory content contains sensitive data" });
      expect(await router.handle(new Request(`${BASE_URL}/api/pi/memory`)).then((item) => item.json())).toEqual([]);
    } finally {
      database.close();
    }
  });
});

async function createResolution(router: ReturnType<typeof createDefaultRouter>, id: string): Promise<Response> {
  return request(router, "/api/pi/memory", "POST", {
    id,
    memory_key: `resolution.${id}`,
    memory_type: "project",
    layer: "long_term",
    scope: "project",
    scope_id: "demo",
    kind: "resolution",
    content: "根因是 completion gate 未复验；修复方式是检查 Evidence 和 Handoff。",
    source_type: "manual",
    source_id: "settings-memory-form",
    citation_type: "handoff",
    citation_id: "issue-785",
    citation_label: "Issue #785 verified handoff",
    confidence: "high"
  });
}

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
