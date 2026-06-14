import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiMemoryItem, listPiMemoryItems } from "../db/repositories/pi.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";

describe("Feishu agent bridge memory candidate notices", () => {
  test("appends approve/reject guidance when normal chat writes a new pending candidate", async () => {
    const fixture = await openFixture();
    try {
      const sent: FeishuTextMessageInput[] = [];
      const config = buildFeishuConnectorConfig({
        FEISHU_ALLOWED_CHAT_IDS: "oc_group",
        FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
      const raw = messageEvent("以后状态汇报都用简短中文 bullet");
      const event = normalizeFeishuMessageEvent(raw);
      const ingest = ingestFeishuMessageEvent(raw, { config, database: fixture.db }, { transport: "websocket" });
      const bridge = createFeishuAgentBridge({
        config: () => config,
        database: fixture.db,
        runConversation: async ({ conversationId }) => {
          createPiMemoryItem(fixture.db, {
            id: "12345678-2222-4222-8222-123456789abc",
            scope: "global",
            scope_id: "runner",
            kind: "user_preference",
            content: "状态汇报使用简短中文 bullet",
            source_type: "pi.conversation",
            source_id: conversationId,
            confidence: "high",
            disabled: 1
          });
          return { conversationId, projectId: "demo", text: "好的，我会按这个风格回复。" };
        },
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_memory_notice" };
        } }
      });

      const result = await bridge.handle({ event, ingest });

      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(listPiMemoryItems(fixture.db, { disabled: 1 })).toMatchObject([
        { disabled: 1, id: "12345678-2222-4222-8222-123456789abc" }
      ]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain("好的，我会按这个风格回复。");
      expect(sent[0]?.text).toContain("我可以记住");
      expect(sent[0]?.text).toContain("12345678");
      expect(sent[0]?.text).toContain("/memory approve 12345678");
      expect(sent[0]?.text).toContain("/memory reject 12345678");
    } finally {
      await fixture.close();
    }
  });

  test("does not append a notice for pre-existing pending candidates", async () => {
    const fixture = await openFixture();
    try {
      const sent: FeishuTextMessageInput[] = [];
      createPiMemoryItem(fixture.db, {
        id: "87654321-2222-4222-8222-123456789abc",
        scope: "global",
        scope_id: "runner",
        kind: "user_preference",
        content: "Already pending",
        source_type: "pi.conversation",
        source_id: "feishu-chat-oc_group-20260614",
        confidence: "medium",
        disabled: 1
      });
      const config = buildFeishuConnectorConfig({
        FEISHU_ALLOWED_CHAT_IDS: "oc_group",
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
      const raw = messageEvent("hi", "om_memory_notice_none");
      const event = normalizeFeishuMessageEvent(raw);
      const ingest = ingestFeishuMessageEvent(raw, { config, database: fixture.db }, { transport: "websocket" });
      const bridge = createFeishuAgentBridge({
        config: () => config,
        database: fixture.db,
        runConversation: async () => ({ text: "普通回复" }),
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_memory_notice_none" };
        } }
      });

      await bridge.handle({ event, ingest });

      expect(sent).toEqual([{
        receiveId: "oc_group",
        receiveIdType: "chat_id",
        text: "普通回复"
      }]);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-memory-notice-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function messageEvent(text: string, messageId = "om_memory_notice_1"): Record<string, unknown> {
  return {
    message: {
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text }),
      create_time: "1781244167890",
      message_id: messageId
    },
    sender: {
      sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
      sender_type: "user",
      tenant_key: "tenant_a"
    }
  };
}
