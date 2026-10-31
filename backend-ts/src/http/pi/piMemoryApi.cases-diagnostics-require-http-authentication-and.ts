import { seedMemoryExperience } from "../../pi/memory/memoryExperienceTestFixtures.ts";
import { expect, test } from "bun:test";
import { createPiMemoryItem, listPiMemoryItems } from "../../db/repositories/pi.ts";
import { createDefaultRouter, createRequestHandler } from "../server.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { appendRunMemoryPrompt, readRunMemorySnapshot, recordExecutorMemoryCitations } from "../../pi/memory/runMemoryContext.ts";
import { createPiMemoryTools } from "../../pi/memory/memoryTools.ts";
import { createMemoryReflectionTools } from "../../pi/memory/memoryReflectionTools.ts";
import { requestMemoryReflection, setMemoryReflectionEnabled } from "../../pi/memory/memoryReflectionQueue.ts";
import { runMemoryReflectionOnce } from "../../agentic/memoryReflectionWorker.ts";
import type { TestFixture } from "./piMemoryApi.testFixture.ts";

export function registerDiagnosticsRequireHttpAuthenticationAndCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, request } = testScope;
  test("diagnostics require HTTP authentication and exact project/Issue/Run scope with strict bounded queries", async () => {
      const db = await openFixtureDatabase();
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
    });
  
  test("diagnostics paginate immutable event identities, expose versions and estimates, and never treat citations as reuse", async () => {
      const db = await openFixtureDatabase();
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
    });
  
  test("memory Action diagnostics distinguish no memory, unrelated retrieval, budget, rejection and create/update/replay", async () => {
      const db = await openFixtureDatabase();
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
    });
  
  test("reflection diagnostics distinguish disabled, queued, no lesson, failures and budgets without exposing raw reasons", async () => {
      for (const mode of ["disabled", "no_evidence", "no_lesson", "failure", "budget", "saved"] as const) {
        const db = await openFixtureDatabase();
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
            const { schema_version, source, outcome, verification, ...content } = seed.experience;
            await tools[0]!.execute("read", {}, undefined, undefined, {} as never);
            await tools.find(t => t.name === "memory_remember")!.execute("save", {
              kind: "debugging_pattern", memory_key: "callback.timeout", confidence: "high",
              content: { ...content, verification: { method: verification.method, evidence_indices: [0] } }
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
      }
    });
  
  test("legacy, malformed and oversized audit facts stay unknown and page limits are enforced", async () => {
      const db = await openFixtureDatabase();
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
    });
  
  test("project reflection setting defaults off and accepts only an explicit boolean", async () => {
      const database = await openFixtureDatabase();
      seedMemoryExperience(database);
      const router = createDefaultRouter({ database });
      const path = "/api/projects/demo/pi/memory-reflection";
      expect(await (await router.handle(new Request(BASE_URL + path))).json()).toMatchObject({ enabled: false });
      expect((await request(router, path, "PUT", { enabled: "true" })).status).toBe(400);
      expect(await (await request(router, path, "PUT", { enabled: true })).json()).toMatchObject({ enabled: true });
      expect(await (await request(router, path, "PUT", { enabled: false })).json()).toMatchObject({ enabled: false });
    });
}
