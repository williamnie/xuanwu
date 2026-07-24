import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems } from "../db/repositories/pi.ts";
import { buildPiMemoryPromptContext } from "./memoryContext.ts";
import { createPiMemoryTools } from "./memoryTools.ts";

describe("PI memory auto-enable policy", () => {
  test("auto-enables explicit low-risk user naming preferences from normal chat", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-name",
        projectID: "demo",
        source: "feishu_runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-name-pref", {
        activate: true,
        kind: "user_preference",
        content: "用户明确要求：把我叫小北，你叫石头。",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({
        confidence: "medium",
        disabled: 0,
        kind: "user_preference",
        scope: "global",
        scope_id: "runner",
        source_id: "conv-name",
        source_type: "pi.conversation"
      });
      expect(listPiMemoryItems(fixture.db, { disabled: 1 })).toEqual([]);
      expect(listPiMemoryItems(fixture.db, { disabled: 0, scope: "global" }))
        .toEqual([expect.objectContaining({ content: "用户明确要求：把我叫小北，你叫石头。" })]);
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .toContain("把我叫小北");
    } finally {
      await fixture.close();
    }
  });

  test("auto-enables explicit low-risk user naming preferences from Runner Chat source", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-runner-name",
        projectID: "demo",
        source: "runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-runner-name-pref", {
        activate: true,
        kind: "user_preference",
        content: "Call the user 小北 and call the assistant 石头.",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 0, scope: "global" });
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .toContain("Call the user 小北");
    } finally {
      await fixture.close();
    }
  });

  test("keeps explicit naming preferences pending without a normal chat source", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-unknown",
        projectID: "demo"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-unknown-name-pref", {
        kind: "user_preference",
        content: "用户明确要求：把我叫小北，你叫石头。"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, scope: "project", scope_id: "demo" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("keeps inferred naming preferences pending even without low confidence", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-infer",
        projectID: "demo",
        source: "runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-infer-pref", {
        kind: "user_preference",
        content: "推断用户可能想让我叫他小北。"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, scope: "project", scope_id: "demo" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("keeps low-confidence explicit naming preferences pending", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-low",
        projectID: "demo",
        source: "feishu_runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-low-pref", {
        kind: "user_preference",
        content: "用户可能想让我叫他小北。",
        confidence: "low",
        scope: "global"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, scope: "global" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("keeps explicit naming preferences with local paths pending", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-path",
        projectID: "demo",
        source: "feishu_runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-path-pref", {
        kind: "user_preference",
        content: "用户明确要求：把我叫小北，详见 /Users/xiaobei/private/note。",
        confidence: "high",
        scope: "global"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, scope: "global" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .not.toContain("/Users/xiaobei/private");
    } finally {
      await fixture.close();
    }
  });

  test("keeps project or team policy observations pending even when phrased explicitly", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-policy",
        projectID: "demo",
        source: "feishu_runner_chat"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-policy-pref", {
        kind: "user_preference",
        content: "用户明确要求：这个项目以后叫小北，团队策略保持人工审核。",
        confidence: "high"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, scope: "project", scope_id: "demo" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("keeps explicit naming preferences pending outside normal chat", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "pi-supervisor-413",
        projectID: "demo",
        source: "pi_supervisor_decision"
      }), "memory_write_candidate");

      const result = await writeCandidate.execute("tool-supervisor-pref", {
        kind: "user_preference",
        content: "用户明确要求：把我叫小北，你叫石头。",
        confidence: "high",
        scope: "global"
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({ disabled: 1, source_type: "pi.supervisor" });
      expect(listPiMemoryItems(fixture.db, { disabled: 0 })).toEqual([]);
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

function toolByName(tools: ReturnType<typeof createPiMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}
