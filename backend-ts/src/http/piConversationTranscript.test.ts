import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PiConversation } from "../db/repositories/pi.ts";
import { piConversationDetail, resolvePiConversationSessionFile } from "./piConversationTranscript.ts";

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
  expect(piConversationDetail(conversation(legacyFile)).transcript).toEqual([
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
