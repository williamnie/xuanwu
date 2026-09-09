import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PiConversation } from "../db/repositories/pi.ts";
import { piConversationDetail, resolvePiConversationSessionFile, PI_CONVERSATION_MESSAGE_LIMIT } from "./piConversationTranscript.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("reads migrated Xuanwu transcripts referenced by legacy app support paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-transcript-migration-"));
  tempRoots.push(root);
  const relativeSessionPath = join("state", "pi-runtime", "sessions", "conversation.jsonl");
  const legacyFile = join(root, "codex-issue-runner-bun-live", relativeSessionPath);
  const xuanwuFile = join(root, "xuanwu-bun-live", relativeSessionPath);
  mkdirSync(dirname(xuanwuFile), { recursive: true });
  writeFileSync(xuanwuFile, JSON.stringify({
    type: "message",
    id: "message-1",
    timestamp: "2026-08-04T00:00:00Z",
    message: { role: "user", content: [{ type: "text", text: "历史消息" }] }
  }));

  expect(resolvePiConversationSessionFile(legacyFile)).toBe(xuanwuFile);
  expect((await piConversationDetail(conversation(legacyFile))).transcript).toEqual([
    {
      id: "message-1",
      role: "user",
      text: "历史消息",
      created_at: "2026-08-04T00:00:00Z",
      meta: { conversation_id: "conversation-1", pi_session_id: "session-1" }
    }
  ]);
});

test("keeps an existing recorded session file authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-transcript-current-"));
  tempRoots.push(root);
  const legacyFile = join(root, "codex-issue-runner-bun-live", "session.jsonl");
  const xuanwuFile = join(root, "xuanwu-bun-live", "session.jsonl");
  mkdirSync(dirname(legacyFile), { recursive: true });
  mkdirSync(dirname(xuanwuFile), { recursive: true });
  writeFileSync(legacyFile, "legacy");
  writeFileSync(xuanwuFile, "xuanwu");

  expect(resolvePiConversationSessionFile(legacyFile)).toBe(legacyFile);
});

function conversation(sessionFile: string): PiConversation {
  return {
    id: "conversation-1",
    project_id: "",
    pi_agent_id: "runner-default",
    title: "History",
    status: "active",
    session_file: sessionFile,
    pi_session_id: "session-1",
    created_at: "2026-08-04T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z"
  };
}

test("oversized transcript lines report an explicit limit instead of an empty history", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-transcript-budget-"));
  tempRoots.push(root);
  const file = join(root, "session.jsonl");
  writeFileSync(file, "x".repeat(16 * 1024 * 1024 + 1));
  await expect(piConversationDetail(conversation(file))).rejects.toThrow("Pi history line exceeds 16 MiB limit");
});


test("Pi conversation total text budget rejects many individually valid UTF-8 lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-transcript-total-budget-"));
  tempRoots.push(root);
  const file = join(root, "session.jsonl");
  const line = JSON.stringify({ type: "message", id: "large", message: { role: "assistant", content: "汉".repeat(350_000) } }) + "\n";
  for (let i = 0; i < 33; i++) await appendFile(file, line);
  await expect(piConversationDetail(conversation(file))).rejects.toThrow("exceeds 32 MiB text or 10000 messages");
});

test("Pi conversation item budget rejects overflow instead of reporting a partial count", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-transcript-item-budget-"));
  tempRoots.push(root);
  const file = join(root, "session.jsonl");
  const line = JSON.stringify({ type: "message", id: "small", message: { role: "user", content: "hello" } }) + "\n";
  writeFileSync(file, line.repeat(PI_CONVERSATION_MESSAGE_LIMIT + 1));
  await expect(piConversationDetail(conversation(file))).rejects.toThrow("exceeds 32 MiB text or 10000 messages");
});
