import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge /new command", () => {
  test("starts a new Feishu PI conversation epoch and strips the command prompt", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ conversationId?: string; prompt: string }> = [];
    const config = configFixture();
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, prompt }) => {
        calls.push({ conversationId, prompt });
        return { conversationId, text: "runner reply" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: `om_reply_${sent.length}` };
      } }
    });
    const reset = normalizeEvent("/new 重新开始", "om_agent_new", config, database);
    const next = normalizeEvent("继续", "om_agent_next", config, database);

    await bridge.handle(reset);
    await bridge.handle(next);

    expect(calls).toEqual([
      { conversationId: "feishu-chat-oc_group-n1", prompt: "重新开始" },
      { conversationId: "feishu-chat-oc_group-n1", prompt: "继续" }
    ]);
    expect(sent).toHaveLength(2);
    database.close();
  });

  test("bumps the epoch without sending a fake prompt when /new has no content", async () => {
    const database = await openFixtureDatabase();
    const calls: Array<{ conversationId?: string; prompt: string }> = [];
    const config = configFixture();
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, prompt }) => {
        calls.push({ conversationId, prompt });
        return { conversationId, text: "should not run" };
      },
      sender: { sendTextMessage: async () => ({ messageId: "om_reply_new_empty" }) }
    });

    const result = await bridge.handle(normalizeEvent("/new", "om_agent_new_empty", config, database));

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(calls).toEqual([]);
    database.close();
  });

  test("uses /new task content as the first new prompt when project mapping is missing", async () => {
    const database = await openFixtureDatabase();
    const calls: Array<{ conversationId?: string; projectId: string; prompt: string }> = [];
    const config = configFixture();
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, projectId, prompt }) => {
        calls.push({ conversationId, projectId, prompt });
        return { conversationId, text: "我会先确认项目再继续。" };
      },
      sender: { sendTextMessage: async () => ({ messageId: "om_reply_new_task" }) }
    });

    await bridge.handle(normalizeEvent("/new 帮我修复登录 bug", "om_agent_new_task", config, database));

    expect(calls).toEqual([{
      conversationId: "feishu-chat-oc_group-n1",
      projectId: "",
      prompt: "帮我修复登录 bug"
    }]);
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-agent-new-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function configFixture() {
  return buildFeishuConnectorConfig({
    FEISHU_ALLOWED_CHAT_IDS: "oc_group",
    FEISHU_APP_ID: "cli_app_id",
    FEISHU_APP_SECRET: "app-secret-value"
  });
}

function fixedClock() {
  return { now: () => new Date(2026, 5, 13, 1, 2, 3) };
}

function normalizeEvent(
  text: string,
  messageId: string,
  config: ReturnType<typeof configFixture>,
  database: RunnerDatabase
) {
  const raw = messageEvent(text, messageId);
  return {
    event: normalizeFeishuMessageEvent(raw),
    ingest: ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" })
  };
}

function messageEvent(text: string, messageId: string): Record<string, unknown> {
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
