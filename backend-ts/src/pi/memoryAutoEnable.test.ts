import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems, listPiMemoryHistory, rememberPiMemoryItem } from "../db/repositories/pi.ts";
import { applyPiMemoryBatchAction } from "./memoryLifecycle.ts";
import { buildPiMemoryPromptContext } from "./memoryContext.ts";
import { createPiMemoryTools } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";

describe("PI automatic reusable memory policy", () => {
  test("auto-enables an explicit user naming preference", async () => {
    const fixture = await openFixture();
    try {
      const remember = memoryTool(fixture.db, "feishu_runner_chat", "conv-name");
      const result = await remember.execute("tool-name", {
        confidence: "high",
        content: "用户明确要求：把我叫小北，你叫石头。",
        kind: "user_preference",
        memory_key: "user.display-name",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({
        disabled: 0,
        kind: "user_preference",
        memory_key: "user.display-name",
        scope: "global",
        scope_id: "runner"
      });
      expect(listPiMemoryItems(fixture.db, { disabled: 1 })).toEqual([]);
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" })).toContain("把我叫小北");
    } finally {
      await fixture.close();
    }
  });

  test("auto-enables an explicit reusable project decision", async () => {
    const fixture = await openFixture();
    try {
      const remember = memoryTool(fixture.db, "runner_chat", "conv-decision");
      const result = await remember.execute("tool-decision", {
        confidence: "high",
        content: "用户明确决定：recovery-only Work 保留失败来源，但不设置 success-only hard dependency。",
        kind: "decision",
        memory_key: "runner.recovery-only-dependency",
        scope: "project",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 0, scope: "project", scope_id: "demo" });
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .toContain("recovery-only Work");
    } finally {
      await fixture.close();
    }
  });

  test("rejects inferred preferences instead of creating a review queue", async () => {
    const fixture = await openFixture();
    try {
      const remember = memoryTool(fixture.db, "runner_chat", "conv-infer");
      const result = await remember.execute("tool-infer", {
        content: "推断用户可能想让我叫他小北。",
        kind: "user_preference",
        memory_key: "user.display-name",
        scope: "global"
      }, undefined, undefined, {} as never);

      expect(result.details).toEqual({
        rejected: true,
        reason: "normal chat memory requires an explicit user statement"
      });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("rejects low-confidence observations instead of persisting candidates", async () => {
    const fixture = await openFixture();
    try {
      const remember = memoryTool(fixture.db, "feishu_runner_chat", "conv-low");
      const result = await remember.execute("tool-low", {
        confidence: "low",
        content: "用户可能偏好简短回复。",
        kind: "user_preference",
        memory_key: "user.reply-style",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toEqual({ rejected: true, reason: "low-confidence observations are not memory" });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("does not allow supervisor status decisions to write memory", async () => {
    const fixture = await openFixture();
    try {
      const remember = memoryTool(fixture.db, "pi_supervisor_decision", "pi-supervisor-413");
      const result = await remember.execute("tool-supervisor", {
        confidence: "high",
        content: "当前 Issue #413 failed。",
        kind: "decision",
        memory_key: "issue.413.status",
        scope: "project"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ rejected: true });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("does not let automatic experience replace an explicit user rule with the same key", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const explicit = memoryTool(fixture.db, "runner_chat", "conv-rule");
      await explicit.execute("preference", {
        kind: "project_preference", content: "修改后运行超时回归", memory_key: "project.timeout", user_authorized: true
      }, undefined, undefined, {} as never);
      const automatic = memoryTool(fixture.db, "pi_manager_cycle", "cycle-rule");
      const result = await automatic.execute("experience", {
        kind: "resolution", content: JSON.stringify(own.experience), memory_key: "project.timeout"
      }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ rejected: true, reason: "automatic experience cannot overwrite explicit user memory" });
      expect(listPiMemoryItems(fixture.db)).toMatchObject([{ authority: "user_explicit", content: "修改后运行超时回归", occurrence_count: 1 }]);
    } finally { await fixture.close(); }
  });

  test("persists disable/forget intent across restart and only a separate user request restores it", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-memory-suppression-"));
    const stateDir = join(root, "state");
    let db = await openDatabase({ stateDir });
    try {
      const own = seedMemoryExperience(db);
      const input = { kind: "resolution" as const, memory_key: "bug.timeout", content: JSON.stringify(own.experience) };
      const execute = (source: string, extra = {}) => memoryTool(db, source, "review").execute("remember", { ...input, ...extra }, undefined, undefined, {} as never);
      const initial = (await execute("pi_manager_cycle")).details as { id: string };
      applyPiMemoryBatchAction(db, { action: "disable", ids: [initial.id] });
      db.close();
      db = await openDatabase({ stateDir });
      expect((await execute("pi_manager_cycle")).details).toMatchObject({ rejected: true });
      expect((await execute("pi_manager_cycle", { reenable: true, user_authorized: true })).details).toMatchObject({ rejected: true });
      // user_authorized 表示内容来自用户，不隐含撤销之前的停用。
      expect((await execute("runner_chat", { user_authorized: true })).details).toMatchObject({ rejected: true });
      expect(listPiMemoryItems(db)).toMatchObject([{ disabled: 1, revision: 2, occurrence_count: 1 }]);
      expect(buildPiMemoryPromptContext(db, { projectID: "demo" })).not.toContain(initial.id);
      expect(applyPiMemoryBatchAction(db, { action: "enable", ids: [initial.id] }))
        .toMatchObject({ action: "enable", updated: [initial.id], skipped: [] });
      expect((await execute("pi_manager_cycle")).details).toMatchObject({ disabled: 0, revision: 3, occurrence_count: 1 });
      applyPiMemoryBatchAction(db, { action: "forget", ids: [initial.id] });
      db.close();
      db = await openDatabase({ stateDir });
      expect((await execute("pi_manager_cycle")).details).toMatchObject({ rejected: true });
      expect(() => rememberPiMemoryItem(db, {
        id: "other-id", scope: "project", scope_id: "demo", ...input, disabled: 0
      })).toThrow(/explicit user re-enable/);
      expect(listPiMemoryItems(db)).toEqual([]);
      const history = listPiMemoryHistory(db, initial.id);
      expect(history.map((entry) => entry.operation)).toEqual(["create", "disable", "enable", "forget"]);
      expect(JSON.stringify(history)).not.toContain(own.experience.root_cause);
      expect((await execute("runner_chat", { user_authorized: true })).details).toMatchObject({ rejected: true });
      expect((await execute("runner_chat", { user_authorized: true, reenable: true })).details)
        .toMatchObject({ disabled: 0, occurrence_count: 1, authority: "user_explicit" });
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("an explicit user adoption is preserved even when the source and text are unchanged", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const input = { kind: "resolution" as const, memory_key: "adopted.lesson", content: JSON.stringify(own.experience) };
      const automatic = memoryTool(fixture.db, "pi_manager_cycle", "review");
      await automatic.execute("automatic", input, undefined, undefined, {} as never);
      const adopted = await memoryTool(fixture.db, "runner_chat", "user-adoption").execute("adopt", {
        ...input, user_authorized: true
      }, undefined, undefined, {} as never);
      expect(adopted.details).toMatchObject({ authority: "user_explicit", authorized_by: "user-adoption", revision: 2, occurrence_count: 1 });
      expect((await automatic.execute("replay", input, undefined, undefined, {} as never)).details).toMatchObject({ rejected: true });
    } finally { await fixture.close(); }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-memory-auto-enable-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function memoryTool(db: RunnerDatabase, source: string, conversationID: string) {
  const tool = createPiMemoryTools(db, { conversationID, projectID: "demo", source })
    .find((candidate) => candidate.name === "memory_remember");
  if (!tool) throw new Error("missing memory_remember");
  return tool;
}
