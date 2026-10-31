import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createProject } from "../../db/repositories/projects.ts";
import { createTelegramAgentBridge } from "./telegramAgentBridge.ts";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";
import { createTelegramChannelConnector } from "./telegramChannelConnector.ts";
import { normalizeTelegramMessageUpdate } from "./telegramEvents.ts";
import type { TestFixture } from "./telegram.testFixture.ts";

export function registerRoutesCallbackResultPresentationThroughCases(testScope: TestFixture) {
  const { trackDatabase, roots, tableCount } = testScope;
  test("routes callback result presentation through the durable IM outbox", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-interaction-result-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const sent: Array<{ chatId: string; messageThreadId?: string; text: string }> = [];
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const connector = createTelegramChannelConnector({
        config,
        database,
        sender: {
          answerCallbackQuery: async () => true,
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true }), getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async (input) => {
            sent.push({ chatId: input.chatId, messageThreadId: input.messageThreadId, text: input.text });
            return { chat: { id: -1001, type: "group" }, date: 1, message_id: 77 };
          },
          setMessageReaction: async () => true
        }
      });
      const bridge = createTelegramAgentBridge({ config: () => config, connector, database });
  
      await bridge.presentInteractionResult({
        callbackId: "callback-result-1",
        chatId: "-1001",
        text: "操作已处理：approved",
        threadId: "4"
      });
  
      expect(sent).toEqual([{ chatId: "-1001", messageThreadId: "4", text: "操作已处理：approved" }]);
      expect(database.sqlite.query<{ feishu_message_id: string; provider_request_ref: string; status: string }, []>(
        "select feishu_message_id, provider_request_ref, status from sync_outbox where source='telegram' limit 1"
      ).get()).toEqual({ feishu_message_id: "", provider_request_ref: "77", status: "sent" });
    });
  
  test("reuses one project selection and interaction binding after an outbound retry", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-selection-retry-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const firstProject = join(root, "first");
      const secondProject = join(root, "second");
      await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
      createProject(database, { cwd: firstProject, id: "first", name: "First", provider: "codex" });
      createProject(database, { cwd: secondProject, id: "second", name: "Second", provider: "codex" });
      const config = buildTelegramConnectorConfig({
        telegramAllowedChatIds: "1",
        telegramAllowedUserIds: "42",
        telegramBotToken: "fixture",
        telegramProjectMappings: "chat:1=first,chat:1=second"
      });
      let sendAttempts = 0;
      let sentThread = "";
      const connector = createTelegramChannelConnector({
        config,
        database,
        sender: {
          answerCallbackQuery: async () => true,
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true, username: "runner_bot" }),
          getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async (input) => {
            sendAttempts += 1;
            if (sendAttempts === 1) throw new Error("temporary send failure");
            sentThread = input.messageThreadId ?? "";
            return { chat: { id: 1, type: "private" }, date: 1, message_id: 20 };
          },
          setMessageReaction: async () => true
        }
      });
      const update = {
        message: {
          chat: { id: 1, type: "supergroup" as const },
          date: 1_700_000_000,
          from: { id: 42, is_bot: false },
          message_id: 17,
          message_thread_id: 6,
          text: "please continue"
        },
        update_id: 31
      };
      const normalized = normalizeTelegramMessageUpdate({ bot: { id: 9, is_bot: true, username: "runner_bot" }, config, update });
      const event = createExternalEvent(database, {
        content: normalized.prompt,
        dedupe_key: normalized.envelope.audit.idempotency_key,
        external_id: normalized.message.message_id,
        source: "telegram"
      });
      const bridge = createTelegramAgentBridge({ config: () => config, connector, database });
      await expect(bridge.handle({ externalEventId: event.id, normalized, update })).rejects.toThrow("temporary send failure");
      expect(tableCount(database, "im_project_selections")).toBe(1);
      expect(tableCount(database, "im_interaction_bindings")).toBe(1);
  
      database.sqlite.run("update sync_outbox set cooldown_until='' where source='telegram'");
      await expect(bridge.handle({ externalEventId: event.id, normalized, update })).resolves.toMatchObject({
        reason: "project_selection_prompted",
        replied: true
      });
      expect(sendAttempts).toBe(2);
      expect(sentThread).toBe("6");
      expect(tableCount(database, "im_project_selections")).toBe(1);
      expect(tableCount(database, "im_interaction_bindings")).toBe(1);
      expect(database.sqlite.query<{ scope_key: string }, []>(
        "select scope_key from im_interaction_bindings limit 1"
      ).get()?.scope_key).toBe("telegram-thread-6");
    });
}
