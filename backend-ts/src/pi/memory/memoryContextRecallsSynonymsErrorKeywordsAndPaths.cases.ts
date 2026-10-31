import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { buildPiMemoryPromptContext, retrievePiMemoryContext } from "./memoryContext.ts";
import { createPiMemoryItem, deletePiMemoryItem, updatePiMemoryItem } from "../../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { MEMORY_SCAN_LIMIT } from "./memoryRetrieval.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, insertMemory } from "./memoryContextTestFixtures.ts";

export function registerRecallsSynonymsErrorKeywordsAndPaths() {
test("recalls synonyms, error keywords and paths with versioned provenance", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    const memory = createPiMemoryItem(db, { id: "timeout", scope: "project", scope_id: "demo", kind: "resolution",
      authority: "evidence_backed", content: JSON.stringify({ ...experience, symptom: "ERR_STREAM_WRITE_AFTER_END in src/response.ts" }) });
    for (const query of ["异步请求逾时，回调重复响应", "async callback timed out", "async callback ETIMEDOUT"]) {
      const result = retrievePiMemoryContext(db, { projectID: "demo", query, errorText: "ERR_STREAM_WRITE_AFTER_END",
        filePaths: ["src/response.ts"], version: "v0.2.13", tokenBudget: 4000 });
      expect(result.memory_items).toHaveLength(1);
      expect(result.memory_items[0]).toMatchObject({ id: memory.id, revision: 1,
        version: experience.version, selection_stage: "text_candidate", authority: "evidence_backed",
        provenance: { reference: "pi_memory_items/timeout" } });
      expect(result.memory_items[0].content_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.memory_items[0].selection_reason).toContain("Pi must verify applicability");
    }
    expect(retrievePiMemoryContext(db, { projectID: "demo", query: "async callback timeout v0.2.13" }).memory_items).toHaveLength(1);
    createPiMemoryItem(db, { id: "path-only", scope: "project", scope_id: "demo", kind: "resolution", authority: "evidence_backed",
      content: JSON.stringify({ ...experience, applies_when: "src/response.ts" }) });
    expect(retrievePiMemoryContext(db, { projectID: "demo", filePaths: ["src/response.ts"], version: "v0.2.13" })
      .memory_items.map((item) => item.id)).toEqual(["path-only"]);
    createPiMemoryItem(db, { id: "error-only", scope: "project", scope_id: "demo", kind: "resolution", authority: "evidence_backed",
      content: JSON.stringify({ ...experience, applies_when: "timeout", symptom: "timeout" }) });
    expect(retrievePiMemoryContext(db, { projectID: "demo", errorText: "ETIMEDOUT", version: "v0.2.13" })
      .memory_items.map((item) => item.id)).toEqual(["error-only"]);
  });

test("recalls mixed-language specification guidance as candidates without requiring every prose word", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    createPiMemoryItem(db, { id: "gate-method", scope: "project", scope_id: "demo", kind: "resolution",
      authority: "evidence_backed", content: JSON.stringify({ ...experience, version: "gate-v1.0.0",
        applies_when: "gate-v1.0.0 的 gate.mjs 按业务规格判定数值阈值，且规格可随 campaign 变化。",
        symptom: "Threshold equality rejected", resolution: "Read SPEC and test the boundary for each campaign" }) });
    const input = { projectID: "demo", query: "gate threshold boundary regression", version: "gate-v1.0.0",
      filePaths: ["SPEC.md", "gate.mjs"],
      taskDescription: "campaign A: integer amounts 0..1000. Eligibility starts at 100 units, including exactly 100." };
    const result = retrievePiMemoryContext(db, input);
    expect(result.memory_items).toHaveLength(1);
    expect(result.memory_items[0]).toMatchObject({ id: "gate-method", selection_stage: "text_candidate" });
    expect(result.memory_items[0].selection_reason).not.toContain("applies_when and version matched");
    expect(retrievePiMemoryContext(db, { ...input, selection: [] }).memory_items).toEqual([]);
    expect(retrievePiMemoryContext(db, { projectID: "demo", version: "gate-v1.0.0",
      query: "gate-v1.0.0 billing invoice" }).memory_items).toEqual([]);
    expect(retrievePiMemoryContext(db, { ...input, version: "gate-v2.0.0" }).memory_items).toEqual([]);
  });

test("keeps single-letter and numeric identifiers in explicit exclusions without excluding their siblings", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    createPiMemoryItem(db, { id: "scoped-gate", scope: "project", scope_id: "demo", kind: "resolution", authority: "evidence_backed",
      content: JSON.stringify({ ...experience, version: "gate-v1.0.0", applies_when: "gate threshold tests; not applicable to campaign B; excluding protocol 2" }) });
    const input = { projectID: "demo", query: "gate threshold tests", version: "gate-v1.0.0" };
    for (const taskDescription of ["campaign A protocol 1", "campaign C protocol 3"]) {
      expect(retrievePiMemoryContext(db, { ...input, taskDescription }).memory_items.map(item => item.id)).toEqual(["scoped-gate"]);
    }
    for (const taskDescription of ["campaign B protocol 1", "CAMPAIGN B protocol 3", "campaign A protocol 2"]) {
      expect(retrievePiMemoryContext(db, { ...input, taskDescription }).memory_items).toEqual([]);
    }
  });

test("excludes unrelated, negative, unknown-version, obsolete and cross-project experience", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    for (const [id, patch] of Object.entries({
      own: {}, other: { scope_id: "other" }, global: { scope: "global", scope_id: "runner" },
      disabled: { disabled: 1 }, forgotten: {}, old: { content: JSON.stringify({ ...experience, version: "v0.1.0" }) },
      platform: { content: JSON.stringify({ ...experience, applies_when: "async callback timeout only on Windows" }) },
      substring: { content: JSON.stringify({ ...experience, applies_when: "OOM", symptom: "out of memory" }) },
      excluded: { content: JSON.stringify({ ...experience, applies_when: "async callback timeout; not applicable to Linux" }) }
    })) {
      createPiMemoryItem(db, { id, scope: "project", scope_id: "demo", kind: "resolution", authority: "evidence_backed",
        content: JSON.stringify(experience), ...patch });
    }
    deletePiMemoryItem(db, "forgotten");
    const input = { projectID: "demo", taskDescription: "async callback timeout on Linux", version: "v0.2.13", tokenBudget: 4000 };
    expect(retrievePiMemoryContext(db, input).memory_items.map((item) => item.id)).toEqual(["own"]);
    for (const patch of [
      { taskDescription: "unrelated billing invoice" }, { taskDescription: "async callback without timeout" },
      { taskDescription: "room reservation" }, { taskDescription: experience.failed_attempts[0] },
      { version: "v0.2.14" }, { version: "v0.2.13 v0.2.14" }, { version: "" }, { projectID: "" }
    ]) expect(retrievePiMemoryContext(db, { ...input, ...patch }).memory_items).toEqual([]);
    updatePiMemoryItem(db, "own", { disabled: 1 });
    expect(retrievePiMemoryContext(db, input).memory_items).toEqual([]);
  });

test("keeps explicit global policy authority, caps technical memories at three and budgets complete items", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    for (let i = 0; i < 8; i++) createPiMemoryItem(db, { id: `technical-${i}`, scope: "project", scope_id: "demo",
      kind: "resolution", authority: "evidence_backed", content: JSON.stringify(experience) });
    createPiMemoryItem(db, { id: "preference", scope: "global", scope_id: "runner", kind: "user_preference",
      authority: "user_explicit", content: "用户要求只做本地验证，不自动部署" });
    const input = { projectID: "demo", taskDescription: "异步请求超时且回调仍可能执行时", version: "v0.2.13", tokenBudget: 4000 };
    const result = retrievePiMemoryContext(db, input);
    expect(result.memory_items).toHaveLength(4);
    expect(result.memory_items[0]).toMatchObject({ id: "preference", authority: "user_explicit", selection_stage: "policy" });
    expect(result.memory_items.filter((item) => item.selection_stage === "text_candidate")).toHaveLength(3);
    expect(result.limits.token_estimate).toBeLessThanOrEqual(4000);
    for (const budget of [0, 1, 80, 320, 700, 900]) {
      const bounded = retrievePiMemoryContext(db, { ...input, tokenBudget: budget });
      expect(bounded.limits.token_estimate).toBeLessThanOrEqual(budget);
      for (const item of bounded.memory_items.filter((item) => item.selection_stage !== "policy")) {
        expect(item.truncated).toBe(false);
        expect(JSON.parse(item.content).failed_attempts).toEqual(experience.failed_attempts);
      }
    }
    expect(retrievePiMemoryContext(db, { ...input, taskDescription: "unrelated" }).memory_items.map((item) => item.id)).toEqual(["preference"]);
  });

test("bounds scans for large stores and ranks relevant experience ahead of newer noise", async () => {
    const db = await openFixtureDatabase();
    const { experience } = seedMemoryExperience(db);
    db.transaction(() => {
      const insert = db.sqlite.prepare(`insert into pi_memory_items
          (id, scope, scope_id, kind, content, authority, created_at, updated_at) values (?, 'project', 'demo', 'resolution', ?, 'evidence_backed', ?, ?)`);
      for (let i = 0; i < 3000; i++) {
        const at = `2026-09-28T${String(i).padStart(8, "0")}`;
        insert.run(`noise-${i}`, JSON.stringify({ ...experience, applies_when: "billing invoice", symptom: "invoice missing" }), at, at);
      }
      insert.run("relevant", JSON.stringify(experience), "2026-09-28T00002900", "2026-09-28T00002900");
      insert.run("outside-window", JSON.stringify(experience), "2026-01-01", "2026-01-01");
    })();
    const result = retrievePiMemoryContext(db, { projectID: "demo", taskDescription: "async callback timed out", version: "v0.2.13" });
    expect(result.memory_items.map((item) => item.id)).toEqual(["relevant"]);
    expect(result.retrieval).toMatchObject({ scanned: MEMORY_SCAN_LIMIT, scan_limited: true });
    expect(result.truncation_summary.total_candidates).toBe(1);
  });

test("uses the bound issue description without reading a different project's task", async () => {
    const db = await openFixtureDatabase();
    const { experience, issueID } = seedMemoryExperience(db);
    createPiMemoryItem(db, { id: "issue-context", scope: "project", scope_id: "demo", kind: "resolution",
      authority: "evidence_backed", content: JSON.stringify(experience) });
    db.sqlite.run("update issues set description=? where id=?", ["async callback timed out v0.2.13", issueID]);
    expect(retrievePiMemoryContext(db, { projectID: "demo", issueID }).memory_items.map((item) => item.id)).toEqual(["issue-context"]);
    expect(retrievePiMemoryContext(db, { projectID: "other", issueID }).memory_items).toEqual([]);
  });
}
