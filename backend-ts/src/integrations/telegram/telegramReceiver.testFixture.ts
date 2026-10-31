import { afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";
import { type TelegramBotClient } from "./telegramClient.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const roots: string[] = [];

  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  function fakeClient(offsets: Array<number | undefined>): TelegramBotClient {
    let emitted = false;
    return {
      answerCallbackQuery: async () => true,
      editMessageReplyMarkup: async () => true,
      getMe: async () => ({ id: 9, is_bot: true, username: "runner_bot" }),
      getUpdates: async (input) => {
        offsets.push(input.offset);
        if (emitted) return pending(input.signal);
        emitted = true;
        return [{
          message: {
            chat: { id: -1001, type: "supergroup" }, date: 1_700_000_000,
            from: { id: 42, is_bot: false }, message_id: 5, text: "hello"
          },
          update_id: 10
        }];
      },
      getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
      sendMessage: async () => ({ chat: { id: -1001, type: "group" }, date: 1, message_id: 1 }),
      setMessageReaction: async () => true
    };
  }

  function batchClient(offsets: Array<number | undefined>): TelegramBotClient {
    let emitted = false;
    const updates = [101, 102, 103].map((updateID) => ({
      message: {
        chat: { id: -1001, type: "supergroup" as const },
        date: 1_700_000_000,
        from: { id: 42, is_bot: false },
        message_id: updateID,
        text: `message ${updateID}`
      },
      update_id: updateID
    }));
    return {
      answerCallbackQuery: async () => true,
      editMessageReplyMarkup: async () => true,
      getMe: async () => ({ id: 9, is_bot: true, username: "runner_bot" }),
      getUpdates: async (input) => {
        offsets.push(input.offset);
        if (emitted) return pending(input.signal);
        emitted = true;
        return updates.filter((update) => input.offset === undefined || update.update_id >= input.offset);
      },
      getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
      sendMessage: async () => ({ chat: { id: -1001, type: "group" }, date: 1, message_id: 1 }),
      setMessageReaction: async () => true
    };
  }

  function receiverConfig() {
    return buildTelegramConnectorConfig({
      TELEGRAM_ALLOWED_CHAT_IDS: "-1001",
      TELEGRAM_ALLOWED_USER_IDS: "42",
      TELEGRAM_BOT_TOKEN: "fixture"
    });
  }

  function pending(signal?: AbortSignal): Promise<never> {
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error("condition not reached");
  }
  return { trackDatabase, roots, fakeClient, batchClient, receiverConfig, pending, waitFor };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
