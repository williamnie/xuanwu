import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFeishuConversationState } from "../db/repositories/feishuConversationState.ts";
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

describe("Feishu project selection flow", () => {
  test("asks with a card, then selection saves active project and continues once", async () => {
    const database = await openFixtureDatabase();
    const sentCards: Record<string, unknown>[] = [];
    const sentTexts: string[] = [];
    const calls: Array<{ conversationId: string; projectId: string; prompt: string }> = [];
    const config = configFixture();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    insertProject(database, "demo", "Demo Project");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, projectId, prompt }) => {
        calls.push({ conversationId, projectId, prompt });
        return { conversationId, projectId, text: "runner continued" };
      },
      sender: {
        sendInteractiveCard: async (input) => {
          sentCards.push(input.card);
          return { messageId: "om_card_continue" };
        },
        sendTextMessage: async (input: FeishuTextMessageInput) => {
          sentTexts.push(input.text);
          return { messageId: `om_text_${sentTexts.length}` };
        }
      }
    });

    await bridge.handle(normalizeEvent("开始做吧", "om_pending_start", config, database));
    const selectionId = selectionIDFromCard(sentCards[0]);
    const first = await bridge.handleProjectSelectionAction({
      action_id: "evt_card_1",
      chat_id: "oc_group",
      message_id: "om_card_continue",
      project_id: "demo",
      selection_id: selectionId,
      user_id: "ou_user_1",
      user_open_id: "ou_open_1"
    });
    const duplicate = await bridge.handleProjectSelectionAction({
      action_id: "evt_card_1_retry",
      chat_id: "oc_group",
      message_id: "om_card_continue",
      project_id: "demo",
      selection_id: selectionId,
      user_id: "ou_user_1",
      user_open_id: "ou_open_1"
    });

    expect(first).toEqual({ reason: "project_selection_continued", replied: true });
    expect(duplicate).toEqual({ reason: "project_selection_already_consumed", replied: false });
    expect(calls).toEqual([{
      conversationId: "feishu-chat-oc_group-20260613",
      projectId: "demo",
      prompt: "开始做吧"
    }]);
    expect(sentTexts).toEqual(["已切到 demo，我会继续处理刚才这句。", "runner continued"]);
    expect(getFeishuConversationState(database, "feishu-chat-oc_group-20260613"))
      .toMatchObject({ active_project_id: "demo", active_project_source: "card_select" });
    database.close();
  });

  test("keeps ordinary chat in PI and uses cards only for missing project task intents", async () => {
    const database = await openFixtureDatabase();
    const sentCards: Record<string, unknown>[] = [];
    const calls: Array<{ projectId: string; prompt: string }> = [];
    const config = configFixture();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ projectId, prompt }) => {
        calls.push({ projectId, prompt });
        return { text: "chat reply" };
      },
      sender: {
        sendInteractiveCard: async (input) => {
          sentCards.push(input.card);
          return { messageId: "om_card_1" };
        },
        sendTextMessage: async () => ({ messageId: "om_text_1" })
      }
    });

    const chat = await bridge.handle(normalizeEvent("hi", "om_plain_chat", config, database));
    const task = await bridge.handle(normalizeEvent("@PI 帮我修复登录 bug", "om_need_project_card", config, database));

    expect(chat).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(task).toEqual({ reason: "project_selection_sent", replied: true });
    expect(calls).toEqual([{ projectId: "", prompt: "hi" }]);
    expect(JSON.stringify(sentCards[0] ?? {})).toContain("codex-issue-runner");
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-project-selection-flow-"));
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

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
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

function selectionIDFromCard(card: Record<string, unknown> | undefined): string {
  const text = JSON.stringify(card ?? {});
  const match = text.match(/"selection_id":"([^"]+)"/);
  if (!match) throw new Error("selection_id missing from card");
  return match[1];
}
