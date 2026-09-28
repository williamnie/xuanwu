import { seedMemoryExperience } from "../pi/memoryExperienceTestFixtures.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiMemoryItem, listPiMemoryItems, type PiMemoryItem } from "../db/repositories/pi.ts";
import { buildPiMemoryPromptContext } from "../pi/memoryContext.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { appendRunMemoryPrompt, readRunMemorySnapshot, recordExecutorMemoryCitations } from "../pi/runMemoryContext.ts";
import { createPiMemoryTools } from "../pi/memoryTools.ts";
import { createMemoryReflectionTools } from "../pi/memoryReflectionTools.ts";
import { requestMemoryReflection, setMemoryReflectionEnabled } from "../pi/memoryReflectionQueue.ts";
import { runMemoryReflectionOnce } from "../agentic/memoryReflectionWorker.ts";

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
  test("diagnostics require HTTP authentication and exact project/Issue/Run scope with strict bounded queries", async () => {
    const db = await openFixtureDatabase();
    try {
      const seed = seedMemoryExperience(db);
      const router = createDefaultRouter({ database: db });
      const handler = createRequestHandler(router, "diagnostic-test-token");
      const path = `${BASE_URL}/api/projects/demo/pi/memory-diagnostics`;
      expect((await handler(new Request(path))).status).toBe(401);
      expect((await handler(new Request(path, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
      expect((await handler(new Request(path, { headers: { authorization: "Bearer diagnostic-test-token" } }))).status).toBe(200);
      for (const query of ["limit=0", "limit=101", "limit=2.5", "after=-1", "after=9007199254740992", "issue_id=0",
        "source=unknown", "source=events", "run_id=bad", "limit=1&limit=2", "status=done", "to=yesterday",
        "from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
        "from=2026-03-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
        "from=2026-02-30T00:00:00.000Z"]) {
        expect((await router.handle(new Request(`${path}?${query}`))).status).toBe(400);
      }
      seedMemoryExperience(db, "other");
      expect((await router.handle(new Request(`${BASE_URL}/api/projects/other/pi/memory-diagnostics?issue_id=${seed.issueID}`))).status).toBe(404);
      expect((await router.handle(new Request(`${path}?issue_id=${seed.issueID}&run_id=other-run`))).status).toBe(404);
      expect((await router.handle(new Request(`${BASE_URL}/api/projects/missing/pi/memory-diagnostics`))).status).toBe(404);
      const empty = await (await router.handle(new Request(path))).json();
      expect(empty).toMatchObject({ items: [], next_after: null, missing_data: "unknown_not_zero_or_not_triggered",
        evidence_supported_reuse: { status: "unknown" }, automatic_reflection: { enabled: false, existing_memory: "preserved_and_still_retrievable" } });
    } finally { db.close(); }
  });

  test("diagnostics paginate immutable event identities, expose versions and estimates, and never treat citations as reuse", async () => {
    const db = await openFixtureDatabase();
    try {
      const seed = seedMemoryExperience(db);
      db.sqlite.run("update issues set description=? where id=?", ["async callback timed out v0.2.13", seed.issueID]);
      createPiMemoryItem(db, { id: "lesson", scope: "project", scope_id: "demo", kind: "resolution", authority: "evidence_backed",
        content: JSON.stringify(seed.experience), source_type: "pi.memory_reflection", source_id: seed.runID });
      appendRunMemoryPrompt(db, seed.issueID, seed.legacyRunID, "Task", "execution");
      const snap = readRunMemorySnapshot(db, seed.issueID, seed.legacyRunID)!;
      const item = snap.memory.memory_items[0]!;
      recordExecutorMemoryCitations(db, seed.issueID, seed.legacyRunID,
        `MEMORY_REF: ${JSON.stringify({ snapshot_id: snap.snapshot_id, id: item.id, revision: item.revision, content_fingerprint: item.content_fingerprint })}`);
      recordIssueEvent(db, seed.issueID, "issue.log", { text: "RAW_PRIVATE_TRANSCRIPT" });
      const router = createDefaultRouter({ database: db });
      const params = new URLSearchParams({ source: "events", issue_id: String(seed.issueID), run_id: seed.legacyRunID, limit: "1" });
      const read = () => router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/memory-diagnostics?${params}`)).then(r => r.json() as Promise<any>);
      const first = await read();
      expect(first.items[0]).toMatchObject({ kind: "retrieval_snapshot", reason_code: "selected",
        memory_refs: [{ id: "lesson", revision: 1, version: seed.experience.version, provenance: { source_id: seed.runID } }],
        cost: { input_tokens: null, output_tokens: null, completeness: "unknown" } });
      expect(first.items[0].cost.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(first.items[0].cost.token_estimate).toBeGreaterThan(0);
      params.set("from", first.range.from); params.set("to", first.range.to);
      expect((await read()).items).toEqual(first.items);
      params.set("after", String(first.next_after));
      const second = await read();
      expect(second.items[0]).toMatchObject({ kind: "injection", attribution: "provider_input_prepared", effectiveness: "not_evaluated" });
      expect(second.items[0].cost.token_estimate).toBeGreaterThan(first.items[0].cost.token_estimate);
      params.set("after", String(second.next_after));
      const third = await read();
      expect(third).toMatchObject({ has_more: false, next_after: null, evidence_supported_reuse: { status: "unknown" } });
      expect(third.items[0]).toMatchObject({ kind: "executor_reference", attribution: "executor_self_report",
        memory_refs: [{ revision: 1, version: seed.experience.version }] });
      const serialized = JSON.stringify([first, second, third]);
      expect(serialized).not.toContain(seed.experience.root_cause);
      expect(serialized).not.toContain("RAW_PRIVATE_TRANSCRIPT");
      params.set("from", "2000-01-01T00:00:00.000Z"); params.set("to", "2000-01-02T00:00:00.000Z");
      expect((await read()).items).toEqual([]);
    } finally { db.close(); }
  });

  test("memory Action diagnostics distinguish no memory, unrelated retrieval, budget, rejection and create/update/replay", async () => {
    const db = await openFixtureDatabase();
    try {
      const seed = seedMemoryExperience(db);
      const tools = createPiMemoryTools(db, { projectID: "demo", issueID: seed.issueID, conversationID: "diag", source: "runner_chat" });
      const invoke = (name: string, args: object) => tools.find(t => t.name === name)!.execute("diag", args, undefined, undefined, {} as never);
      await invoke("memory_search", { query: "callback" });
      const input = { kind: "project_preference", memory_key: "project.minimal", content: "Prefer minimal patches", user_authorized: true };
      await invoke("memory_remember", input);
      await invoke("memory_remember", input);
      await invoke("memory_remember", { ...input, content: "Prefer minimal verified patches" });
      await invoke("memory_search", { query: "totally-unrelated" });
      await invoke("memory_search", { query: "minimal", token_budget: 0 });
      await invoke("memory_search", { query: "minimal", token_budget: 1 });
      const denied = createPiMemoryTools(db, { projectID: "demo", issueID: seed.issueID,
        authorization: { mode: "delegated", allowedActions: ["memory.search"], scope: { project_id: "demo" } } });
      await denied.find(t => t.name === "memory_remember")!.execute("denied", input, undefined, undefined, {} as never);
      const router = createDefaultRouter({ database: db });
      const data: any = await (await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/memory-diagnostics?source=actions&issue_id=${seed.issueID}&limit=100`))).json();
      const searches = data.items.filter((x: any) => x.kind === "memory_search" && x.stage === "execution_result");
      expect(searches.map((x: any) => x.reason_code)).toEqual([
        "no_memory_in_window", "no_matching_candidate", "retrieval_budget_disabled", "token_budget_exhausted"
      ]);
      expect(searches[1].retrieval.excluded.unrelated).toBe(1);
      expect(data.items.filter((x: any) => x.kind === "memory_write" && x.stage === "execution_result").map((x: any) => x.write_result))
        .toEqual(["created", "unchanged", "updated"]);
      expect(data.items.some((x: any) => x.gate_decision === "deny")).toBe(true);
      expect(JSON.stringify(data)).not.toContain(input.content);
      expect(data.evidence_supported_reuse.status).toBe("unknown");
    } finally { db.close(); }
  });

  test("reflection diagnostics distinguish disabled, queued, no lesson, failures and budgets without exposing raw reasons", async () => {
    for (const mode of ["disabled", "no_evidence", "no_lesson", "failure", "budget", "saved"] as const) {
      const db = await openFixtureDatabase();
      try {
        const seed = seedMemoryExperience(db);
        if (mode !== "disabled") setMemoryReflectionEnabled(db, "demo", true);
        db.sqlite.run("update issues set status='done' where id=?", [seed.issueID]);
        db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [new Date().toISOString(), seed.legacyRunID]);
        recordIssueEvent(db, seed.issueID, "issue.pi_acceptance_applied.v1", { action: "accept", run_id: seed.legacyRunID });
        if (mode === "no_evidence") db.sqlite.run("delete from issue_events where type='evidence.recorded.v1'");
        requestMemoryReflection(db, seed.issueID);
        const router = createDefaultRouter({ database: db });
        const read = (source: string) => router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/memory-diagnostics?source=${source}&issue_id=${seed.issueID}&run_id=${seed.legacyRunID}`)).then(r => r.json() as Promise<any>);
        if (mode !== "disabled") expect((await read("reflections")).items[0].status).toBe(mode === "no_evidence" ? "skipped" : "pending");
        await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
          if (mode === "failure") throw new Error("provider failed RAW_SECRET_ERROR token=sk-test-secret-diagnostic");
          if (mode === "budget") throw new Error("reflection model input budget exceeded");
          if (mode === "saved") {
            const tools = createMemoryReflectionTools(db, lease);
            await tools[0]!.execute("read", {}, undefined, undefined, {} as never);
            await tools.find(t => t.name === "memory_remember")!.execute("save", {
              kind: "debugging_pattern", memory_key: "callback.timeout", confidence: "high", content: JSON.stringify({ ...seed.experience,
                source: { ...seed.experience.source, refs: [`work:${seed.workID}`, `run:${seed.runID}`] } })
            }, undefined, undefined, {} as never);
            return '{"status":"saved"}';
          }
          return '{"status":"skipped","reason":"no_new_reusable_experience"}';
        } });
        const data = await read("events");
        expect(data.items[0]).toMatchObject({ kind: "reflection_trigger", reason_code: mode === "disabled" ? "project_disabled"
          : mode === "no_evidence" ? "no_valid_evidence" : "queued" });
        if (mode !== "disabled" && mode !== "no_evidence") {
          const attempt = data.items.find((x: any) => x.kind === "reflection_attempt");
          expect(attempt).toMatchObject({ reason_code: mode === "failure" ? "call_failed" : mode === "budget" ? "model_input_budget_exhausted"
            : mode === "saved" ? "experience_saved" : "no_new_reusable_experience",
            cost: { completeness: "unknown", input_tokens: null, cost_usd: null } });
          expect(attempt.cost.elapsed_ms).toBeGreaterThanOrEqual(0);
        }
        expect(JSON.stringify(data)).not.toContain("RAW_SECRET_ERROR");
        expect(JSON.stringify(data)).not.toContain("lease_token");
        const memories = listPiMemoryItems(db);
        setMemoryReflectionEnabled(db, "demo", false);
        expect(listPiMemoryItems(db)).toEqual(memories);
        const closed = await read("reflections");
        expect(closed.automatic_reflection).toMatchObject({ enabled: false, existing_memory: "preserved_and_still_retrievable" });
        if (mode === "failure" || mode === "budget") expect(closed.items[0].reason_code).toBe("project_disabled");
        if (mode === "saved") {
          expect(memories).toHaveLength(1);
          expect((await read("actions")).items.some((x: any) => x.write_result === "created")).toBe(true);
        }
      } finally { db.close(); }
    }
  });

  test("legacy, malformed and oversized audit facts stay unknown and page limits are enforced", async () => {
    const db = await openFixtureDatabase();
    try {
      const seed = seedMemoryExperience(db);
      recordIssueEvent(db, seed.issueID, "issue.run_memory_injected.v1", { issue_run_id: seed.legacyRunID,
        memory_refs: [{ id: "old", revision: 2, content: "PRIVATE_MEMORY_BODY", source_id: "Authorization: Bearer abc-SECRET" }] });
      recordIssueEvent(db, seed.issueID, "issue.run_memory_snapshot.v1", "{invalid json");
      recordIssueEvent(db, seed.issueID, "issue.run_memory_snapshot.v1", { large: "s".repeat(65537) });
      for (let i = 0; i < 101; i++) recordIssueEvent(db, seed.issueID, "issue.run_memory_cited.v1", {});
      const router = createDefaultRouter({ database: db });
      const path = `${BASE_URL}/api/projects/demo/pi/memory-diagnostics?source=events&issue_id=${seed.issueID}&limit=100`;
      const first: any = await (await router.handle(new Request(path))).json();
      expect(first.items).toHaveLength(100);
      expect(first).toMatchObject({ has_more: true });
      expect(first.items[0]).toMatchObject({ reason_code: "unknown", memory_refs: [{ id: "old", version: null }],
        cost: { elapsed_ms: null, input_tokens: null, token_estimate: null } });
      expect(first.items[1].data_status).toBe("unknown_invalid");
      expect(first.items[2].data_status).toBe("unknown_oversized");
      expect(JSON.stringify(first)).not.toContain("PRIVATE_MEMORY_BODY");
      expect(JSON.stringify(first)).not.toContain("abc-SECRET");
      const next: any = await (await router.handle(new Request(`${path}&after=${first.next_after}`))).json();
      expect(next.items).toHaveLength(4);
      expect(next.has_more).toBe(false);
    } finally { db.close(); }
  });

  test("project reflection setting defaults off and accepts only an explicit boolean", async () => {
    const database = await openFixtureDatabase();
    try {
      seedMemoryExperience(database);
      const router = createDefaultRouter({ database });
      const path = "/api/projects/demo/pi/memory-reflection";
      expect(await (await router.handle(new Request(BASE_URL + path))).json()).toMatchObject({ enabled: false });
      expect((await request(router, path, "PUT", { enabled: "true" })).status).toBe(400);
      expect(await (await request(router, path, "PUT", { enabled: true })).json()).toMatchObject({ enabled: true });
      expect(await (await request(router, path, "PUT", { enabled: false })).json()).toMatchObject({ enabled: false });
    } finally { database.close(); }
  });

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
        occurrence_count: 1
      });
      expect(await list.json()).toEqual([
        expect.objectContaining({ id: "mem-first", occurrence_count: 1 })
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
        content: "根因是仅查看 Run 叙述；修复并复验 completion gate、Evidence 和 Handoff。",
        disabled: 0,
        pinned: 1
      });
      expect(beforeForget).not.toContain("修复并复验 completion gate、Evidence 和 Handoff");
      expect(await forgot.json()).toEqual({ forgotten: true });
      expect(buildPiMemoryPromptContext(database, { projectID: "demo" })).not.toContain("typed-memory");
    } finally {
      database.close();
    }
  });

  test("exposes immutable correction history and honors optional revision preconditions", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const original = await createResolution(router, "history-memory").then((res) => res.json()) as PiMemoryItem;
      const edited = await request(router, "/api/pi/memory/history-memory", "PATCH", {
        content: "根因限定为共享响应时的取消竞争；修复后通过双回调顺序测试。", expected_revision: 1,
        occurrence_count: 999, revision: 999
      });
      expect(await edited.json()).toMatchObject({ revision: 2, occurrence_count: 1, authority: "user_explicit" });
      const stale = await request(router, "/api/pi/memory/history-memory", "PATCH", { content: "根因是旧判断；修复方式待验证。", expected_revision: 1 });
      expect(stale.status).toBe(400);
      const history = await router.handle(new Request(`${BASE_URL}/api/pi/memory/history-memory/history`)).then((res) => res.json());
      expect(history).toMatchObject([
        { revision: 1, operation: "create", snapshot: { content: original.content, citation_id: "issue-785" } },
        { revision: 2, operation: "edit", snapshot: { occurrence_count: 1 } }
      ]);
      await request(router, "/api/pi/memory/history-memory/forget", "POST", {});
      const forgottenHistory = await router.handle(new Request(`${BASE_URL}/api/pi/memory/history-memory/history`)).then((res) => res.json());
      expect(forgottenHistory).toHaveLength(3);
      expect(JSON.stringify(forgottenHistory)).not.toContain(original.content);
    } finally { database.close(); }
  });

  test("create/replay cannot bypass disable or delete; explicit re-enable remains available", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const original = await createResolution(router, "lifecycle-memory").then((res) => res.json()) as PiMemoryItem;
      await request(router, "/api/pi/memory/lifecycle-memory/disable", "POST", {});
      expect((await createResolution(router, "lifecycle-memory")).status).toBe(400);
      expect((await request(router, "/api/pi/memory/batch", "POST", { action: "enable", ids: [original.id] })).status).toBe(200);
      expect((await createResolution(router, "lifecycle-memory")).status).toBe(201);
      const deleted = await request(router, "/api/pi/memory/lifecycle-memory", "DELETE", {});
      expect(await deleted.json()).toEqual({ deleted: true });
      expect((await createResolution(router, "lifecycle-memory")).status).toBe(400);
      const restored = await request(router, "/api/pi/memory", "POST", { ...original, reenable: true });
      expect(restored.status).toBe(201);
      expect(await restored.json()).toMatchObject({ id: original.id, disabled: 0, revision: 5, occurrence_count: 1 });
    } finally { database.close(); }
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
      // 旧文本仍可管理，但缺少适用条件/版本的技术经验不自动注入。
      expect(prompt).not.toContain("Issue #785 failed 的根因");
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
