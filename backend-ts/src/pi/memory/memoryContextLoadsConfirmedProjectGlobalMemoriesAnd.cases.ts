import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { buildPiMemoryPromptContext, retrievePiMemoryContext } from "./memoryContext.ts";
import { createPiMemoryItem, deletePiMemoryItem, updatePiMemoryItem } from "../../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { MEMORY_SCAN_LIMIT } from "./memoryRetrieval.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, insertMemory } from "./memoryContextTestFixtures.ts";

export function registerLoadsConfirmedProjectGlobalMemoriesAnd() {
test("loads confirmed project/global memories and omits disabled candidates", async () => {
    const db = await openFixtureDatabase();
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
  });

test("orders scoped memories with a bounded limit and traceable references", async () => {
    const db = await openFixtureDatabase();
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
  });

test("retrieves reusable scoped memories with provenance and omits transient inbox summaries", async () => {
    const db = await openFixtureDatabase();
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
  });

test("stably truncates memory retrieval by token budget", async () => {
    const db = await openFixtureDatabase();
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
  });
}
