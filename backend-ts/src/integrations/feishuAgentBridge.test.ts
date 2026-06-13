import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge", () => {
  test("sends trusted task messages with project mapping to Runner agent and replies in chat", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复这个 bug");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "hello from runner" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_1" };
      } }
    });

    await bridge.handle({ event, ingest });

    expect(prompts).toEqual(["@PI 帮我修复这个 bug"]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "hello from runner"
    }]);
    database.close();
  });

  test("routes trusted chat-only messages to PI conversation for natural replies", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi", "om_agent_chat_only");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "我在，这件事我可以继续帮你跟进。" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_chat_only" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(prompts).toEqual(["hi"]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我在，这件事我可以继续帮你跟进。"
    }]);
    database.close();
  });

  test("asks for project mapping instead of starting Runner agent for task messages without a project", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复登录 bug", "om_agent_needs_project");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_needs_project" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "project_clarification_sent", replied: true });
    expect(prompts).toEqual([]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我收到任务了，但还不知道要交给哪个 Runner 项目。请在设置页添加 Project Mappings，或在消息里带上项目名后再发。"
    }]);
    database.close();
  });

  test("does not reply twice for the same Feishu message id", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi again");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "runner once" }),
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_1" };
      } }
    });

    await bridge.handle({ event, ingest });
    await bridge.handle({ event, ingest });

    expect(sent).toHaveLength(1);
    database.close();
  });

  test("reports Runner errors as a natural Feishu reply", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复登录 bug", "om_agent_runner_error");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => {
        throw new Error("provider failed CODEX_API_KEY=secret /Users/xiaobei/private");
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_runner_error" };
      } }
    });

    const result = await bridge.handle({ event, ingest });
    const text = sent[0]?.text ?? "";

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(text).toContain("尝试交给 Runner 时出错");
    expect(text).not.toContain("Runner agent failed");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/Users/xiaobei/private");
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-agent-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function messageEvent(text: string, messageId = "om_agent_1"): Record<string, unknown> {
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
