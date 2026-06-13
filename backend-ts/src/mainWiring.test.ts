import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("server entrypoint wiring", () => {
  test("passes executor providers into Feishu PI conversations", () => {
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

    expect(source).toContain("runPiConversationPrompt({ bus, database, providers }");
  });
  test("uses a stable Feishu chat/thread conversation id instead of per-message ids", () => {
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

    expect(source).toContain("conversationId: feishuConversationID(event)");
    expect(source).not.toContain("conversationId: feishuConversationID(event.message_id)");
    expect(source).toContain("event.thread_id || event.root_id || event.chat_id || event.message_id");
  });

});
