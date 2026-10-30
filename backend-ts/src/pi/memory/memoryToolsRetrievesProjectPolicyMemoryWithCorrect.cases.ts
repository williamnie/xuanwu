import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import {
  createPiMemoryItem,
  getPiMemoryItem,
  listPiActionEvents,
  listPiActions,
  listPiMemoryItems,
  listPiMemoryHistory,
  rememberPiMemoryItem,
  updatePiMemoryItem,
  deletePiMemoryItem
} from "../../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, openFixture, toolByName, validateArgs, seedMemory, seedProjectPolicyFixture, policyMemory, itemIds, concurrentRemember } from "./memoryToolsTestFixtures.ts";

export function registerRetrievesProjectPolicyMemoryWithCorrect() {
test("retrieves project policy memory with correct project/global scope and redaction", async () => {
    const fixture = await openFixture();
    try {
      seedProjectPolicyFixture(fixture.db);
      const search = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo" }), "memory_search");

      expect(validateArgs(search, { kind: "project_policy_memory", scope: "project" }))
        .toMatchObject({ kind: "project_policy_memory", scope: "project" });
      const allRelevant = await search.execute("tool-project", {
        query: "Prefer"
      }, undefined, undefined, {} as never);
      const projectPolicy = await search.execute("tool-policy", {
        kind: "project_policy_memory",
        query: "runner",
        scope: "project"
      }, undefined, undefined, {} as never);
      const sensitive = await search.execute("tool-secret", {
        query: "fixture-secret",
        scope: "project"
      }, undefined, undefined, {} as never);
      const staleStatus = await search.execute("tool-stale-status", {
        query: "785",
        scope: "project"
      }, undefined, undefined, {} as never);

      expect(itemIds(allRelevant.details)).toEqual(expect.arrayContaining([
        "global-user-preference",
        "project-policy-memory"
      ]));
      expect(itemIds(allRelevant.details)).not.toContain("other-project-memory");
      expect(itemIds(projectPolicy.details)).toEqual(["project-policy-memory"]);
      expect(itemIds(sensitive.details)).toEqual([]);
      expect(itemIds(staleStatus.details)).toEqual([]);
      expect(JSON.stringify(sensitive.details)).not.toContain("fixture-secret");
    } finally {
      await fixture.close();
    }
  });

test("corrects only with new evidence and an explicit narrower scope, retaining version provenance", async () => {
    const fixture = await openFixture();
    try {
      const firstSource = seedMemoryExperience(fixture.db);
      const secondSource = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const invoke = (content: unknown, correction?: { expected_revision: number; disposition: "narrow" | "disable"; reason: string }) =>
        remember.execute("correction", { kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(content), ...(correction ? { correction } : {}) }, undefined, undefined, {} as never);
      const original = (await invoke(firstSource.experience)).details as { id: string };
      const incoming = { ...secondSource.experience, root_cause: "超时取消未覆盖共享响应的所有回调", version: "runner v0.2.14" };
      expect((await invoke(incoming)).details).toMatchObject({ rejected: true });
      const correction = { expected_revision: 1, disposition: "narrow" as const, reason: "新的回归证明仅共享响应的回调需要此约束" };
      expect((await invoke(incoming, correction)).details).toMatchObject({ rejected: true });
      const narrow = { ...incoming, applies_when: "异步请求超时且多个回调共享同一响应时" };
      const repeatEvidence = { ...firstSource.experience, applies_when: narrow.applies_when };
      expect((await invoke(repeatEvidence, correction)).details).toMatchObject({ rejected: true });
      const corrected = (await invoke(narrow, correction)).details;
      expect(corrected).toMatchObject({ id: original.id, revision: 2, occurrence_count: 2, disabled: 0 });
      expect(listPiMemoryHistory(fixture.db, original.id)).toMatchObject([
        { revision: 1, operation: "create", snapshot: { content: JSON.stringify(firstSource.experience) } },
        { revision: 2, operation: "correct", correction, snapshot: { content: JSON.stringify(narrow) } }
      ]);
      // 旧来源回放不回滚已修正的结论；同一修正重试也不虚增出现次数。
      expect((await invoke(firstSource.experience)).details).toEqual(corrected);
      expect((await invoke(narrow, correction)).details).toEqual(corrected);
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(2);
      const stale = seedMemoryExperience(fixture.db);
      expect((await invoke({ ...stale.experience, applies_when: "仅旧取消协议生效时" }, correction)).details)
        .toMatchObject({ rejected: true, reason: expect.stringContaining("revision conflict") });
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(2);
    } finally { await fixture.close(); }
  });

test("one failed task cannot invalidate a lesson, while verified conflict can disable it", async () => {
    const fixture = await openFixture();
    try {
      const old = seedMemoryExperience(fixture.db);
      const newer = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const initial = await remember.execute("initial", { kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(old.experience) }, undefined, undefined, {} as never);
      const failed = { ...newer.evidence, id: `${newer.evidence.id}-failure` as typeof newer.evidence.id, status: "failed" as const };
      newer.persistEvidence(failed);
      const correction = { expected_revision: 1, disposition: "disable" as const, reason: "独立回归显示旧修复不适用于新取消协议" };
      const input = { kind: "resolution" as const, memory_key: "bug.timeout", correction,
        content: JSON.stringify({ ...newer.experience, verification: { ...newer.experience.verification, evidence_refs: [`evidence:${failed.id}`] } }) };
      expect((await remember.execute("failed-task", input, undefined, undefined, {} as never)).details).toMatchObject({ rejected: true });
      const id = (initial.details as { id: string }).id;
      expect(getPiMemoryItem(fixture.db, id)).toMatchObject({ revision: 1, disabled: 0 });
      const disabled = await remember.execute("verified-conflict", { ...input, content: JSON.stringify(newer.experience) }, undefined, undefined, {} as never);
      expect(disabled.details).toMatchObject({ revision: 2, disabled: 1 });
      expect(retrievePiMemoryContext(fixture.db, { projectID: "demo" }).memory_items).toEqual([]);
      expect(listPiMemoryHistory(fixture.db, id).map((entry) => entry.operation)).toEqual(["create", "correct"]);
    } finally { await fixture.close(); }
  });

test("same Run can gain a new evidence-backed revision without adding an occurrence", async () => {
    const fixture = await openFixture();
    try {
      const source = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const input = { kind: "resolution" as const, memory_key: "same-run.lesson", content: JSON.stringify(source.experience) };
      const initial = (await remember.execute("first", input, undefined, undefined, {} as never)).details as { id: string };
      const evidence = { ...source.evidence, id: `${source.evidence.id}-additional` as typeof source.evidence.id };
      source.persistEvidence(evidence);
      const correction = { expected_revision: 1, disposition: "narrow" as const, reason: "同一 Run 的新增回归覆盖共享取消句柄" };
      const result = await remember.execute("second", { ...input, correction,
        content: JSON.stringify({ ...source.experience, applies_when: "仅共享取消句柄且响应回调仍可执行时",
          verification: { ...source.experience.verification, evidence_refs: [`evidence:${evidence.id}`] } })
      }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ id: initial.id, revision: 2, occurrence_count: 1, source_id: source.runID });
      expect(listPiMemoryHistory(fixture.db, initial.id)).toHaveLength(2);
    } finally { await fixture.close(); }
  });

test("rolls back item, receipt, suppression and history together when persistence fails", async () => {
    const fixture = await openFixture();
    try {
      const input = { id: "atomic", scope: "project", scope_id: "demo", kind: "decision", content: "用户明确要求小改动", memory_key: "atomic.lesson", source_id: "first" };
      const original = rememberPiMemoryItem(fixture.db, input);
      fixture.db.sqlite.run(`create trigger reject_memory_history before insert on pi_memory_history
        when new.revision>1 begin select raise(abort, 'fixture history unavailable'); end`);
      expect(() => rememberPiMemoryItem(fixture.db, { ...input, content: "用户明确要求增加定向测试", source_id: "second" })).toThrow("fixture history unavailable");
      expect(() => updatePiMemoryItem(fixture.db, original.id, { disabled: 1 })).toThrow("fixture history unavailable");
      expect(() => deletePiMemoryItem(fixture.db, original.id)).toThrow("fixture history unavailable");
      expect(getPiMemoryItem(fixture.db, original.id)).toEqual(original);
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(1);
      expect(fixture.db.sqlite.query("select * from pi_memory_suppressions").all()).toEqual([]);
      expect(fixture.db.sqlite.query("select * from pi_memory_receipts").all()).toHaveLength(1);
      fixture.db.sqlite.run("drop trigger reject_memory_history");
      expect(rememberPiMemoryItem(fixture.db, { ...input, source_id: "second" })).toMatchObject({ revision: 2, occurrence_count: 2 });
    } finally { await fixture.close(); }
  });

test("serializes independent processes and preserves correction ownership after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-memory-concurrent-"));
    let db = await openDatabase({ stateDir: join(root, "state"), writerBusyTimeoutMs: 10000 }).then(trackDatabase);
    try {
      const original = seedMemoryExperience(db);
      const left = seedMemoryExperience(db);
      const right = seedMemoryExperience(db);
      const input = { kind: "resolution", memory_key: "concurrent.lesson", content: JSON.stringify(original.experience) };
      const [a, b] = await concurrentRemember(root, db.path, [input, input]);
      expect(a).toMatchObject({ revision: 1, occurrence_count: 1 });
      expect(b).toMatchObject({ id: a.id, revision: 1, occurrence_count: 1 });
      const correctedInputs = [left, right].map((source, i) => ({ ...input,
        content: JSON.stringify({ ...source.experience, applies_when: `仅回调分支 ${i} 共享响应且会超时时` }),
        correction: { expected_revision: 1, disposition: "narrow", reason: `独立回归限定分支 ${i}` }
      }));
      const outcomes = await concurrentRemember(root, db.path, correctedInputs);
      expect(outcomes.filter((item) => item.revision === 2)).toHaveLength(1);
      expect(outcomes.filter((item) => item.rejected === true)).toMatchObject([{ reason: expect.stringContaining("revision conflict") }]);
      const winner = outcomes.find((item) => item.revision === 2)!;
      db.close();
      db = await openDatabase({ dbPath: join(root, "state", "runner.db") }).then(trackDatabase);
      const persisted = getPiMemoryItem(db, a.id);
      if (!persisted) throw new Error("concurrent memory missing after restart");
      expect(winner).toEqual(persisted);
      expect(listPiMemoryHistory(db, a.id)).toMatchObject([
        { revision: 1, snapshot: { content: input.content } },
        { revision: 2, operation: "correct", snapshot: { content: winner.content } }
      ]);
      const [replay] = await concurrentRemember(root, db.path, [input]);
      expect(replay).toEqual(winner);
      expect(listPiMemoryHistory(db, a.id)).toHaveLength(2);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
}
