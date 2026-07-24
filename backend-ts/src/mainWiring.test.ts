import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("server entrypoint wiring", () => {
  test("passes executor providers into Feishu PI conversations", () => {
    const source = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");

    expect(source).toContain("runPiConversationPrompt({ bus, database, providers }");
  });
  test("uses a stable Feishu chat/thread conversation id instead of per-message ids", () => {
    const source = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");

    expect(source).toContain("runConversation: async ({ conversationId, event, projectId, prompt, targetProjectId, targetProjectSource })");
    expect(source).toContain("conversationId,");
    expect(source).toContain("targetProjectSource,");
    expect(source).toContain("channelContext: buildFeishuConversationPromptContext(database, { event })");
    expect(source).not.toContain("continuation?.issueId");
    expect(source).not.toContain("feishuConversationID");
    expect(source).not.toContain("event.thread_id || event.root_id || event.chat_id || event.message_id");
  });

  test("loads Web and Core runtime graphs only after selecting a role", () => {
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

    expect(source).toContain('await import("./runtime/web.ts")');
    expect(source).toContain('await import("./runtime/core.ts")');
    expect(source).not.toContain('from "./db/database.ts"');
    expect(source).not.toContain('from "./providers/');
  });

});
