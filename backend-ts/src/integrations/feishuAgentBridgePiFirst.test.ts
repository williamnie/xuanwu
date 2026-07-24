import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiGuardianEvents } from "../db/repositories/pi.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("Feishu agent bridge PI-first boundary", () => {
  test("passes every semantic message to PI unchanged instead of executing command parsers", async () => {
    const database = await openFixtureDatabase();
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "PI reply" };
      },
      sender: { sendTextMessage: async () => ({ messageId: `om_reply_${prompts.length}` }) }
    });
    const messages = [
      "重试吧",
      "retry",
      "/issue 修复上下文",
      "/review 最近的对话",
      "/memory approve abc1",
      "/notify {\"mode\":\"quiet\"}",
      "/p codex-issue-runner",
      "等 #774 做完通知我"
    ];

    for (const [index, text] of messages.entries()) {
      expect(await bridge.handle(normalizeEvent(text, `om_pi_first_${index}`, config, database)))
        .toEqual({ reason: "agent_reply_sent", replied: true });
    }

    expect(prompts).toEqual(messages);
    database.close();
  });

  test("surfaces a missing PI runtime instead of acknowledging semantic work", async () => {
    const database = await openFixtureDatabase();
    const replies: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      sender: {
        sendTextMessage: async (input) => {
          replies.push(input.text);
          return { messageId: "om_pi_unavailable_reply" };
        }
      }
    });

    expect(await bridge.handle(normalizeEvent("重试吧", "om_pi_unavailable", config, database)))
      .toEqual({ reason: "agent_reply_sent", replied: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Xuanwu Supervisor conversation provider is unavailable");
    expect(listPiGuardianEvents(database)).toContainEqual(expect.objectContaining({
      event_type: "guardian.pi_supervisor.unavailable",
      severity: "urgent",
      source: "supervisor"
    }));
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-pi-first-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function normalizeEvent(
  text: string,
  messageId: string,
  config: ReturnType<typeof buildFeishuConnectorConfig>,
  database: RunnerDatabase
) {
  const raw = {
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
  return {
    event: normalizeFeishuMessageEvent(raw),
    ingest: ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" })
  };
}
