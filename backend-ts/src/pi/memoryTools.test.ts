import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiMemoryItem, listPiActionEvents, listPiActions, listPiMemoryItems } from "../db/repositories/pi.ts";
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
      expect(getPiMemoryItem(fixture.db, String(candidate.details.id))).toMatchObject({ disabled: 1 });
      expect((activeSearch.details as { items: unknown[] }).items).toEqual([]);
      expect((candidateSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(candidate.details.id)]);
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
