import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildPiMemoryPromptContext, retrievePiMemoryContext } from "./memoryContext.ts";
import { createPiMemoryItem, deletePiMemoryItem, updatePiMemoryItem } from "../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { MEMORY_SCAN_LIMIT } from "./memoryRetrieval.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-memory-context-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI memory prompt context", () => {
  test("loads confirmed project/global memories and omits disabled candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: "User prefers concise Chinese status updates",
        id: "global-pref",
        kind: "user_preference",
        scope: "global",
        scopeID: "runner"
      });
      insertMemory(db, {
        content: "Project policy: verify before commit",
        id: "project-policy",
        kind: "project_policy",
        pinned: 1,
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Unconfirmed guess should stay hidden",
        disabled: 1,
        id: "candidate",
        kind: "decision",
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "当前 Issue #785 failed，等待人工处理。",
        id: "legacy-status-snapshot",
        kind: "project_observation",
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Issue #785 failed 的根因是只看 Run 结果；修复方式是以 Evidence、Handoff 和 completion gate 复验。",
        id: "issue-785-resolution",
        kind: "resolution",
        scope: "project",
        scopeID: "demo"
      });

      const context = buildPiMemoryPromptContext(db, { projectID: "demo" });

      expect(context).toContain("Reusable Supervisor memory");
      expect(context).toContain("Project policy: verify before commit");
      expect(context).toContain("User prefers concise Chinese status updates");
      expect(context).not.toContain("Unconfirmed guess");
      expect(context).not.toContain("等待人工处理");
      expect(context).not.toContain("Issue #785 failed 的根因");
      expect(context).toContain("pi_memory_items/project-policy");
      expect(context).toContain("source=runbook:policy-doc");
      expect(context).toContain("updated=2026-01-01T00:00:00Z");
      expect(context).toContain("memory_remember");
      expect(context).toContain("always query authoritative tools for current state");
    } finally {
      db.close();
    }
  });

  test("orders scoped memories with a bounded limit and traceable references", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: "Global fallback",
        id: "global",
        kind: "decision",
        scope: "global",
        scopeID: "runner"
      });
      insertMemory(db, {
        content: "Project scoped policy",
        id: "project",
        kind: "project_policy",
        pinned: 1,
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Issue-specific acceptance",
        id: "issue",
        kind: "decision",
        scope: "issue",
        scopeID: "259"
      });

      const context = buildPiMemoryPromptContext(db, { issueID: 259, limit: 2, projectID: "demo" });

      expect(context).toContain("Issue-specific acceptance");
      expect(context).toContain("Project scoped policy");
      expect(context).not.toContain("Global fallback");
      expect(context.indexOf("pi_memory_items/issue")).toBeLessThan(context.indexOf("pi_memory_items/project"));
    } finally {
      db.close();
    }
  });

  test("retrieves reusable scoped memories with provenance and omits transient inbox summaries", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: "Source default project is demo when confidence is high",
        id: "source-memory",
        kind: "source_project_hint",
        scope: "source",
        scopeID: "fixture-im"
      });
      insertMemory(db, {
        content: "Domain skill should ask before creating issues for ambiguous projects",
        id: "skill-memory",
        kind: "skill_policy",
        scope: "skill",
        scopeID: "fixture-domain"
      });
      insertMemory(db, {
        content: "Inbox item already has a screenshot summary",
        id: "inbox-memory",
        kind: "inbox_summary",
        scope: "inbox",
        scopeID: "42"
      });
      insertMemory(db, {
        content: "Project scoped fallback",
        id: "project-memory",
        kind: "project_policy",
        scope: "project",
        scopeID: "demo"
      });

      const result = retrievePiMemoryContext(db, {
        inboxItemID: 42,
        limit: 4,
        projectID: "demo",
        skillID: "fixture-domain",
        sourceID: "fixture-im",
        tokenBudget: 1000
      });

      expect(result.memory_items.map((item) => item.id)).toEqual([
        "source-memory", "skill-memory", "project-memory"
      ]);
      expect(result.memory_items[0]).toMatchObject({
        reference: "pi_memory_items/source-memory",
        retrieval_scope: "source:fixture-im",
        source_id: "policy-doc",
        source_path: "pi_memory_items/source-memory"
      });
      expect(result.retrieval_scopes).toEqual([
        "inbox:42", "source:fixture-im", "skill:fixture-domain", "project:demo", "global:runner"
      ]);
    } finally {
      db.close();
    }
  });

  test("stably truncates memory retrieval by token budget", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: `Long memory ${"x".repeat(500)}`,
        id: "long-memory",
        kind: "project_policy",
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Should be outside the budget",
        id: "second-memory",
        kind: "project_policy",
        scope: "project",
        scopeID: "demo"
      });

      const result = retrievePiMemoryContext(db, { projectID: "demo", tokenBudget: 320 });

      expect(result.memory_items).toHaveLength(1);
      expect(result.memory_items[0]).toMatchObject({ id: "long-memory", truncated: true });
      expect(result.memory_items[0].content).toContain("…");
      expect(result.limits).toMatchObject({ token_budget: 320, truncated: true });
      expect(result.limits.token_estimate).toBeLessThanOrEqual(320);
    } finally {
      db.close();
    }
  });

  test("explains selected memories with provenance and truncation summary", async () => {
    const db = await openFixtureDatabase();
    try {
      insertMemory(db, {
        content: `Long project memory ${"x".repeat(500)}`,
        id: "explain-long",
        kind: "project_policy",
        pinned: 1,
        scope: "project",
        scopeID: "demo"
      });
      insertMemory(db, {
        content: "Second memory should be omitted by budget",
        id: "explain-second",
        kind: "project_policy",
        scope: "project",
        scopeID: "demo"
      });

      const result = retrievePiMemoryContext(db, { projectID: "demo", tokenBudget: 320 });

      expect(result.memory_items[0]).toMatchObject({
        id: "explain-long",
        provenance: {
          reference: "pi_memory_items/explain-long",
          source_id: "policy-doc",
          source_type: "runbook"
        },
        retrieval_scope: "project:demo",
        selection_reason: "scope project:demo matched retrieval request; pinned memory ranked first",
        truncated: true
      });
      expect(result.truncation_summary).toMatchObject({
        omitted_count: 1,
        omitted_by_token_budget: 1,
        selected_count: 1,
        token_budget: 320,
        total_candidates: 2,
        truncated_item_ids: ["explain-long"]
      });
      expect(result.truncation_summary.summary).toContain("token budget");
    } finally {
      db.close();
    }
  });
});

describe("task-scoped experience retrieval", () => {
  test("recalls synonyms, error keywords and paths with versioned provenance", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("recalls mixed-language specification guidance as candidates without requiring every prose word", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("keeps single-letter and numeric identifiers in explicit exclusions without excluding their siblings", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("excludes unrelated, negative, unknown-version, obsolete and cross-project experience", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("keeps explicit global policy authority, caps technical memories at three and budgets complete items", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("bounds scans for large stores and ranks relevant experience ahead of newer noise", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally { db.close(); }
  });

  test("uses the bound issue description without reading a different project's task", async () => {
    const db = await openFixtureDatabase();
    try {
      const { experience, issueID } = seedMemoryExperience(db);
      createPiMemoryItem(db, { id: "issue-context", scope: "project", scope_id: "demo", kind: "resolution",
        authority: "evidence_backed", content: JSON.stringify(experience) });
      db.sqlite.run("update issues set description=? where id=?", ["async callback timed out v0.2.13", issueID]);
      expect(retrievePiMemoryContext(db, { projectID: "demo", issueID }).memory_items.map((item) => item.id)).toEqual(["issue-context"]);
      expect(retrievePiMemoryContext(db, { projectID: "other", issueID }).memory_items).toEqual([]);
    } finally { db.close(); }
  });
});

function insertMemory(db: RunnerDatabase, item: {
  content: string; disabled?: number; id: string; kind: string; pinned?: number; scope: string; scopeID: string;
}): void {
  db.sqlite.run(
    `insert into pi_memory_items
      (id, scope, scope_id, kind, content, source_type, source_id, confidence, pinned, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.id, item.scope, item.scopeID, item.kind, item.content, "runbook", "policy-doc", "high", item.pinned ?? 0, item.disabled ?? 0,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
