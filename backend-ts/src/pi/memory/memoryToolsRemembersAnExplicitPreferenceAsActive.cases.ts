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

export function registerRemembersAnExplicitPreferenceAsActive() {
test("remembers an explicit preference as active memory and reuses its stable key", async () => {
    const fixture = await openFixture();
    try {
      const tools = createPiMemoryTools(fixture.db, {
        conversationID: "conv-1",
        projectID: "demo",
        source: "runner_chat"
      });
      const search = toolByName(tools, "memory_search");
      const remember = toolByName(tools, "memory_remember");

      expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_MEMORY_TOOL_NAMES].sort());
      expect(validateArgs(search, { query: "minimal", scope: "project" })).toEqual({
        query: "minimal",
        scope: "project"
      });
      expect(validateArgs(remember, {
        kind: "user_preference", content: "Prefer small patches", memory_key: "user.patch-size"
      })).toMatchObject({ kind: "user_preference", memory_key: "user.patch-size" });
      expect(() => validateArgs(remember, { kind: "user_preference", content: " ", memory_key: "user.patch-size" }))
        .toThrow(/Validation failed/);
      expect(() => validateArgs(search, { include_candidates: true })).toThrow(/Validation failed/);

      const remembered = await remember.execute("tool-1", {
        kind: "user_preference",
        content: "Prefer small patches",
        confidence: "high",
        memory_key: "user.patch-size",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);
      const activeSearch = await search.execute("tool-2", {
        query: "patches"
      }, undefined, undefined, {} as never);
      const secondSearch = await search.execute("tool-3", { query: "patches" }, undefined, undefined, {} as never);

      expect(remembered.details).toMatchObject({
        authority: "user_explicit",
        authorized_by: "conv-1",
        disabled: 0,
        kind: "user_preference",
        memory_key: "user.patch-size",
        occurrence_count: 1,
        scope: "global",
        scope_id: "runner",
        source_id: "conv-1",
        source_type: "pi.conversation"
      });
      const rememberedDetails = remembered.details as { id: string };
      expect(getPiMemoryItem(fixture.db, String(rememberedDetails.id))).toMatchObject({ disabled: 0 });
      expect((activeSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(rememberedDetails.id)]);
      expect((secondSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(rememberedDetails.id)]);
      expect(listPiMemoryItems(fixture.db, { disabled: 1 })).toEqual([]);
      const memorySearchActions = listPiActions(fixture.db).filter((item) => item.action_type === "memory.search");
      expect(memorySearchActions).toHaveLength(2);
      expect(memorySearchActions.every((item) => item.status === "completed")).toBe(true);
      const action = listPiActions(fixture.db).find((item) => item.action_type === "memory.remember");
      expect(action).toMatchObject({
        conversation_id: "conv-1",
        gate_decision: "execute",
        project_id: "runner",
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
        projectID: "demo",
        source: "runner_chat"
      }), "memory_remember");

      const result = await writeCandidate.execute("tool-secret", {
        kind: "constraint",
        content: "XUANWU_AUTH_TOKEN=fixture-secret",
        confidence: "high",
        memory_key: "project.secret",
        user_authorized: true
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

test("activates only an explicitly authorized structured preference without inspecting wording", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-authorized",
        projectID: "demo",
        source: "runner_chat"
      }), "memory_remember");

      const result = await writeCandidate.execute("tool-authorized", {
        content: "Zed",
        kind: "user_preference",
        memory_key: "user.display-name",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({
        content: "Zed",
        disabled: 0,
        kind: "user_preference",
        scope: "global"
      });
    } finally {
      await fixture.close();
    }
  });

test("rejects status snapshots and deduplicates evidence-backed manager experience", async () => {
    const fixture = await openFixture();
    try {
      const remember = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "manager-cycle-1",
        projectID: "demo",
        source: "pi_manager_cycle"
      }), "memory_remember");

      const rejected = await remember.execute("tool-status", {
        confidence: "high",
        content: "当前 Issue #785 failed，等待人工处理。",
        evidence_ref: "run:785",
        kind: "resolution",
        memory_key: "bug.785.resolution",
        scope: "project"
      }, undefined, undefined, {} as never);
      expect(rejected.details).toEqual({
        rejected: true,
        reason: "current Work/Run/Issue status snapshots are not memory"
      });

      const seeded = seedMemoryExperience(fixture.db);
      const input = {
        confidence: "high",
        content: JSON.stringify(seeded.experience),
        evidence_ref: `handoff:${seeded.handoff.handoff.id}`,
        kind: "resolution" as const,
        memory_key: "runner.recovery-only-dependency",
        scope: "project"
      };
      const first = await remember.execute("tool-resolution-1", input, undefined, undefined, {} as never);
      const second = await remember.execute("tool-resolution-2", {
        ...input,
        content: JSON.stringify(Object.fromEntries(Object.entries(seeded.experience).reverse()))
      }, undefined, undefined, {} as never);

      expect(first.details).toMatchObject({ disabled: 0, occurrence_count: 1 });
      expect(first.details).toMatchObject({ authority: "evidence_backed", authorized_by: input.evidence_ref });
      expect(second.details).toMatchObject({
        disabled: 0,
        memory_key: "runner.recovery-only-dependency",
        occurrence_count: 1, revision: 1
      });
      expect(listPiMemoryItems(fixture.db)).toHaveLength(1);
      expect(retrievePiMemoryContext(fixture.db, { projectID: "demo", tokenBudget: 4000,
        taskDescription: "异步请求超时且回调仍可能执行时，响应被重复写入", version: "v0.2.13" }).memory_items[0])
        .toMatchObject({ authority: "evidence_backed", content: JSON.stringify(seeded.experience) });
    } finally {
      await fixture.close();
    }
  });
}
