import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems } from "../db/repositories/pi.ts";
import { buildPiMemoryPromptContext } from "./memoryContext.ts";
import { createPiMemoryTools } from "./memoryTools.ts";

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
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-memory-auto-enable-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function memoryTool(db: RunnerDatabase, source: string, conversationID: string) {
  const tool = createPiMemoryTools(db, { conversationID, projectID: "demo", source })
    .find((candidate) => candidate.name === "memory_remember");
  if (!tool) throw new Error("missing memory_remember");
  return tool;
}
