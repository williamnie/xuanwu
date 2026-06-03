import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  getPiMemoryItem,
  listPiActionEvents,
  listPiActions,
  listPiMemoryItems
} from "../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";

describe("PI memory tools", () => {
  test("defines search/write_candidate tools and writes candidates disabled", async () => {
    const fixture = await openFixture();
    try {
      const tools = createPiMemoryTools(fixture.db, {
        conversationID: "conv-1",
        projectID: "demo"
      });
      const search = toolByName(tools, "memory_search");
      const writeCandidate = toolByName(tools, "memory_write_candidate");

      expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_MEMORY_TOOL_NAMES].sort());
      expect(validateArgs(search, { query: "minimal", scope: "project" })).toEqual({
        query: "minimal",
        scope: "project"
      });
      expect(validateArgs(writeCandidate, { kind: "preference", content: "Prefer small patches" }))
        .toMatchObject({ kind: "preference", content: "Prefer small patches" });
      expect(() => validateArgs(writeCandidate, { kind: "preference", content: " " }))
        .toThrow(/Validation failed/);

      const candidate = await writeCandidate.execute("tool-1", {
        kind: "preference",
        content: "Prefer small patches",
        confidence: "high"
      }, undefined, undefined, {} as never);
      const activeSearch = await search.execute("tool-2", {
        query: "patches",
        scope: "project"
      }, undefined, undefined, {} as never);
      const candidateSearch = await search.execute("tool-3", {
        include_candidates: true,
        query: "patches",
        scope: "project"
      }, undefined, undefined, {} as never);

      expect(candidate.details).toMatchObject({
        disabled: 1,
        kind: "preference",
        scope: "project",
        scope_id: "demo",
        source_id: "conv-1",
        source_type: "pi.conversation"
      });
      const candidateDetails = candidate.details as { id: string };
      expect(getPiMemoryItem(fixture.db, String(candidateDetails.id))).toMatchObject({ disabled: 1 });
      expect((activeSearch.details as { items: unknown[] }).items).toEqual([]);
      expect((candidateSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(candidateDetails.id)]);
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
      const memorySearchActions = listPiActions(fixture.db).filter((item) => item.action_type === "memory.search");
      expect(memorySearchActions).toHaveLength(2);
      expect(memorySearchActions.every((item) => item.status === "completed")).toBe(true);
      const action = listPiActions(fixture.db).find((item) => item.action_type === "memory.write_candidate");
      expect(action).toMatchObject({
        conversation_id: "conv-1",
        gate_decision: "execute",
        project_id: "demo",
        status: "completed"
      });
      expect(listPiActionEvents(fixture.db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("does not persist sensitive memory candidates from PI tools", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-secret",
        projectID: "demo"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-secret", {
        kind: "provider_runtime",
        content: "CODEX_RUNNER_AUTH_TOKEN=fixture-secret",
        confidence: "high"
      }, undefined, undefined, {} as never);

      expect(result.details).toEqual({
        rejected: true,
        reason: "memory content contains sensitive data"
      });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

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

      expect(itemIds(allRelevant.details)).toEqual(expect.arrayContaining([
        "global-user-preference",
        "project-policy-memory"
      ]));
      expect(itemIds(allRelevant.details)).not.toContain("other-project-memory");
      expect(itemIds(projectPolicy.details)).toEqual(["project-policy-memory"]);
      expect(itemIds(sensitive.details)).toEqual([]);
      expect(JSON.stringify(sensitive.details)).not.toContain("fixture-secret");
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-memory-tools-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function toolByName(tools: ReturnType<typeof createPiMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}

function seedMemory(db: RunnerDatabase, item: {
  content: string; id: string; kind: string; scope: string; scope_id: string;
}) {
  return createPiMemoryItem(db, {
    ...item,
    confidence: "high",
    disabled: 0
  });
}

function seedProjectPolicyFixture(db: RunnerDatabase): void {
  seedMemory(db, policyMemory("project-policy-memory", "demo",
    "Prefer verification evidence before marking runner issues done"));
  seedMemory(db, {
    id: "global-user-preference",
    scope: "global",
    scope_id: "runner",
    kind: "user_preference",
    content: "Prefer concise Chinese progress updates"
  });
  seedMemory(db, {
    id: "global-policy-memory",
    scope: "global",
    scope_id: "runner",
    kind: "project_policy_memory",
    content: "Prefer runner-level housekeeping"
  });
  seedMemory(db, policyMemory("other-project-memory", "other", "Prefer broad refactors"));
  seedMemory(db, policyMemory("sensitive-memory", "demo", "CODEX_RUNNER_AUTH_TOKEN=fixture-secret"));
}

function policyMemory(id: string, scopeID: string, content: string) {
  return { id, scope: "project", scope_id: scopeID, kind: "project_policy_memory", content };
}

function itemIds(details: unknown): string[] {
  const items = (details as { items?: Array<{ id: string }> }).items ?? [];
  return items.map((item) => item.id).sort();
}
