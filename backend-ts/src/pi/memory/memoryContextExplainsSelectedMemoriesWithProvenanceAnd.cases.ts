import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { buildPiMemoryPromptContext, retrievePiMemoryContext } from "./memoryContext.ts";
import { createPiMemoryItem, deletePiMemoryItem, updatePiMemoryItem } from "../../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { MEMORY_SCAN_LIMIT } from "./memoryRetrieval.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, insertMemory } from "./memoryContextTestFixtures.ts";

export function registerExplainsSelectedMemoriesWithProvenanceAnd() {
test("explains selected memories with provenance and truncation summary", async () => {
    const db = await openFixtureDatabase();
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
  });
}
