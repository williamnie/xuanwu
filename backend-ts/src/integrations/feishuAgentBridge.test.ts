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
  test("sends trusted long-connection messages to Runner agent and replies in chat", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi");
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

    expect(prompts).toEqual(["hi"]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "hello from runner"
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
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-agent-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function messageEvent(text: string): Record<string, unknown> {
  return {
    message: {
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text }),
      create_time: "1781244167890",
      message_id: "om_agent_1"
    },
    sender: {
      sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
      sender_type: "user",
      tenant_key: "tenant_a"
    }
  };
}
