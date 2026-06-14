import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiMemoryItem, getPiMemoryItem } from "../db/repositories/pi.ts";
import { buildPiMemoryPromptContext } from "../pi/memoryContext.ts";
import { applyFeishuMemoryCommand } from "./feishuMemoryCommands.ts";

describe("Feishu /memory commands", () => {
  test("lists pending candidates for current conversation, project, and global scope with redaction", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        scope: "conversation",
        scope_id: "conv-1",
        content: "Conversation preference: keep replies short"
      });
      seedMemory(fixture.db, {
        id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        scope: "project",
        scope_id: "demo",
        content: "Project note references /Users/xiaobei/private"
      });
      seedMemory(fixture.db, {
        id: "cccccccc-3333-4333-8333-cccccccccccc",
        scope: "global",
        scope_id: "runner",
        content: "CODEX_RUNNER_AUTH_TOKEN=fixture-secret"
      });
      seedMemory(fixture.db, {
        id: "dddddddd-4444-4444-8444-dddddddddddd",
        scope: "project",
        scope_id: "other",
        content: "Other project candidate"
      });
      seedMemory(fixture.db, {
        disabled: 0,
        id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
        scope: "project",
        scope_id: "demo",
        content: "Confirmed memory should not be in pending list"
      });

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_candidates_listed" });
      expect(result.text).toContain("待审核记忆");
      expect(result.text).toContain("aaaaaaaa");
      expect(result.text).toContain("bbbbbbbb");
      expect(result.text).toContain("cccccccc");
      expect(result.text).not.toContain("dddddddd");
      expect(result.text).not.toContain("eeeeeeee");
      expect(result.text).not.toContain("/Users/xiaobei/private");
      expect(result.text).not.toContain("fixture-secret");
    } finally {
      await fixture.close();
    }
  });

  test("approves a candidate by short id and then injects it into PI memory context", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        id: "abc12345-1111-4111-8111-aaaaaaaaaaaa",
        scope: "project",
        scope_id: "demo",
        content: "Approved memory enters prompt"
      });

      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .not.toContain("Approved memory enters prompt");

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory approve abc12345"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_candidate_approved" });
      expect(getPiMemoryItem(fixture.db, "abc12345-1111-4111-8111-aaaaaaaaaaaa"))
        .toMatchObject({ disabled: 0 });
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .toContain("Approved memory enters prompt");
    } finally {
      await fixture.close();
    }
  });

  test("does not approve candidates outside current scope", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        id: "99999999-1111-4111-8111-aaaaaaaaaaaa",
        scope: "project",
        scope_id: "other",
        content: "Other project memory"
      });

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory approve 99999999"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_candidate_not_found" });
      expect(getPiMemoryItem(fixture.db, "99999999-1111-4111-8111-aaaaaaaaaaaa"))
        .toMatchObject({ disabled: 1 });
    } finally {
      await fixture.close();
    }
  });

  test("does not approve sensitive candidates", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        id: "88888888-1111-4111-8111-aaaaaaaaaaaa",
        scope: "project",
        scope_id: "demo",
        content: "CODEX_RUNNER_AUTH_TOKEN=fixture-secret"
      });

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory approve 88888888"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_candidate_sensitive" });
      expect(result.text).not.toContain("fixture-secret");
      expect(getPiMemoryItem(fixture.db, "88888888-1111-4111-8111-aaaaaaaaaaaa"))
        .toMatchObject({ disabled: 1 });
    } finally {
      await fixture.close();
    }
  });

  test("rejects a candidate by short id and keeps it out of PI memory context", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        id: "fedcba98-1111-4111-8111-aaaaaaaaaaaa",
        scope: "project",
        scope_id: "demo",
        content: "Rejected memory stays hidden"
      });

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory reject fedcba98"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_candidate_rejected" });
      expect(getPiMemoryItem(fixture.db, "fedcba98-1111-4111-8111-aaaaaaaaaaaa")).toBeNull();
      expect(buildPiMemoryPromptContext(fixture.db, { projectID: "demo" }))
        .not.toContain("Rejected memory stays hidden");
    } finally {
      await fixture.close();
    }
  });

  test("searches confirmed memory only and omits disabled candidates", async () => {
    const fixture = await openFixture();
    try {
      seedMemory(fixture.db, {
        disabled: 0,
        id: "11111111-1111-4111-8111-111111111111",
        scope: "project",
        scope_id: "demo",
        content: "Prefer minimal verification"
      });
      seedMemory(fixture.db, {
        id: "22222222-2222-4222-8222-222222222222",
        scope: "project",
        scope_id: "demo",
        content: "Prefer minimal unconfirmed candidate"
      });

      const result = applyFeishuMemoryCommand(fixture.db, {
        conversationId: "conv-1",
        projectId: "demo",
        text: "/memory search minimal"
      });

      expect(result).toMatchObject({ handled: true, reason: "memory_search_sent" });
      expect(result.text).toContain("已确认记忆");
      expect(result.text).toContain("11111111");
      expect(result.text).toContain("Prefer minimal verification");
      expect(result.text).not.toContain("22222222");
      expect(result.text).not.toContain("unconfirmed candidate");
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-memory-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function seedMemory(db: RunnerDatabase, item: {
  content: string; disabled?: number; id: string; scope: string; scope_id: string;
}): void {
  createPiMemoryItem(db, {
    confidence: "high",
    content: item.content,
    disabled: item.disabled ?? 1,
    id: item.id,
    kind: "preference",
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: "conv-1",
    source_type: "pi.conversation"
  });
}
