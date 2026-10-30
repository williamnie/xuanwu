import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createImInteractionBinding, getImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";
import { TelegramClientError } from "./telegramClient.ts";
import { createTelegramChannelConnector, createTelegramImOutboundEnvelope, splitTelegramText } from "./telegramChannelConnector.ts";
import { encodeTelegramCallbackData } from "./telegramCallbackCodec.ts";
import { resolveTelegramInteraction } from "./telegramInteractionAdapter.ts";
import type { TestFixture } from "./telegram.testFixture.ts";

export function registerSplitsByParagraphThenUnicodeCases(testScope: TestFixture) {
  const { trackDatabase, roots } = testScope;
  test("splits by paragraph then Unicode rune and reuses durable per-part receipts", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-connector-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      expect(splitTelegramText(`abc\n\ndef`, 5)).toEqual(["abc\n\n", "def"]);
      expect(splitTelegramText("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
      const sent: string[] = [];
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1", TELEGRAM_ALLOWED_USER_IDS: "2", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const connector = createTelegramChannelConnector({
        config,
        database,
        sender: {
          answerCallbackQuery: async () => true,
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true }),
          getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async (input) => {
            sent.push(input.text);
            return { chat: { id: -1, type: "group" }, date: 1, message_id: sent.length };
          },
          setMessageReaction: async () => true
        }
      });
      const text = "a".repeat(4096) + "😀";
      const envelope = createTelegramImOutboundEnvelope({
        actionGateRef: "policy:1", actionID: "action:1", authority: "deterministic_policy",
        correlationID: "conversation:1", eventRef: "event:1", idempotencyKey: "telegram-send:1",
        operation: "message.reply", target: { connector_id: "telegram", conversation_id: "-1" }, text
      });
      const first = await connector.deliver!(envelope);
      const replay = await connector.deliver!(envelope);
      expect(sent).toEqual(["a".repeat(4096), "😀"]);
      expect(first.provider_message_refs).toEqual(["1", "2"]);
      expect(replay).toMatchObject({ provider_message_refs: ["1", "2"], replayed: true });
    });
  
  test("retries a split delivery without resending its durable prefix", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-partial-retry-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const sent: string[] = [];
      let failSecondPart = true;
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1", TELEGRAM_ALLOWED_USER_IDS: "2", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const connector = createTelegramChannelConnector({
        config,
        database,
        sender: {
          answerCallbackQuery: async () => true,
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true }),
          getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async (input) => {
            sent.push(input.text);
            if (sent.length === 2 && failSecondPart) throw new Error("temporary second-part failure");
            return { chat: { id: -1, type: "group" }, date: 1, message_id: sent.length };
          },
          setMessageReaction: async () => true
        }
      });
      const envelope = createTelegramImOutboundEnvelope({
        actionGateRef: "policy:1", actionID: "action:partial", authority: "deterministic_policy",
        correlationID: "conversation:partial", eventRef: "event:partial", idempotencyKey: "telegram-send:partial",
        operation: "message.reply", target: { connector_id: "telegram", conversation_id: "-1" },
        text: "a".repeat(4096) + "b"
      });
  
      await expect(connector.deliver!(envelope)).rejects.toThrow("temporary second-part failure");
      failSecondPart = false;
      const retry = await connector.deliver!(envelope);
  
      expect(sent).toEqual(["a".repeat(4096), "b", "b"]);
      expect(retry.provider_message_refs).toEqual(["1", "3"]);
      expect(database.sqlite.query<{ count: number }, []>(
        "select count(*) as count from connector_delivery_parts where connector_id='telegram' and idempotency_key='telegram-send:partial'"
      ).get()).toEqual({ count: 2 });
    });
  
  test("pauses only the affected chat after Telegram returns retry_after", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-chat-rate-limit-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let now = 1_000;
      const calls: string[] = [];
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1,-2", TELEGRAM_ALLOWED_USER_IDS: "2", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const connector = createTelegramChannelConnector({
        config,
        database,
        now: () => now,
        sender: {
          answerCallbackQuery: async () => true,
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true }),
          getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async (input) => {
            calls.push(input.chatId);
            if (input.chatId === "-1" && calls.filter((id) => id === "-1").length === 1) {
              throw new TelegramClientError("limited", { kind: "rate_limited", retryAfterSeconds: 7, status: 429 });
            }
            return { chat: { id: input.chatId, type: "group" }, date: 1, message_id: calls.length };
          },
          setMessageReaction: async () => true
        }
      });
      const envelope = (chatId: string, key: string) => createTelegramImOutboundEnvelope({
        actionGateRef: "policy:rate-limit", actionID: `action:${key}`, authority: "deterministic_policy",
        correlationID: `conversation:${key}`, eventRef: `event:${key}`, idempotencyKey: `telegram-send:${key}`,
        operation: "message.reply", target: { connector_id: "telegram", conversation_id: chatId }, text: "hello"
      });
  
      await expect(connector.deliver!(envelope("-1", "first"))).rejects.toMatchObject({ retryAfterSeconds: 7 });
      await expect(connector.deliver!(envelope("-1", "second"))).rejects.toMatchObject({ retryAfterSeconds: 7 });
      expect(await connector.deliver!(envelope("-2", "other"))).toMatchObject({ provider_request_ref: "2" });
      expect(calls).toEqual(["-1", "-2"]);
  
      now += 7_000;
      expect(await connector.deliver!(envelope("-1", "after"))).toMatchObject({ provider_request_ref: "3" });
      expect(calls).toEqual(["-1", "-2", "-1"]);
    });
  
  test("resolves an inline action through the server binding exactly once and clears the keyboard", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-interaction-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const token = "abcdefghijklmnopqrstuv";
      createImInteractionBinding(database, {
        actionKind: "project_selection",
        actionRef: "im_project_selections:selection-1",
        actions: [{ action_id: "project_0", value: "demo" }],
        actor: { id: "42" }, connectorId: "telegram", conversationId: "-1001",
        expiresAt: "2099-01-01T00:00:00.000Z", interactionId: token, revision: 1, scopeKey: "telegram-thread-4"
      });
      const calls: string[] = [];
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const result = await resolveTelegramInteraction({
        callback: {
          data: encodeTelegramCallbackData({ actionIndex: 0, interactionId: token, revision: 1 }),
          from: { id: 42, is_bot: false }, id: "callback-1",
          message: { chat: { id: -1001, type: "supergroup" }, date: 1, message_id: 8, message_thread_id: 4 }
        },
        client: {
          answerCallbackQuery: async () => { calls.push("answer"); return true; },
          editMessageReplyMarkup: async () => { calls.push("clear"); return true; },
          getMe: async () => ({ id: 9, is_bot: true }), getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async () => ({ chat: { id: -1001, type: "group" }, date: 1, message_id: 9 }),
          setMessageReaction: async () => true
        },
        config,
        database,
        projectSelection: async (input) => {
          expect(input).toMatchObject({ chatId: "-1001", projectId: "demo", selectionId: "selection-1", threadId: "4", userId: "42" });
          return { ok: true, status: "continued" };
        }
      });
      expect(result).toMatchObject({ reason: "consumed", resolution: { ok: true, status: "continued" } });
      expect(calls).toEqual(["answer", "clear"]);
      expect(getImInteractionBinding(database, token)?.status).toBe("consumed");
    });
  
  test("answers an expired callback once with a stable error before running its resolver", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-expired-interaction-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const token = "expiredabcdefghijklmn";
      createImInteractionBinding(database, {
        actionKind: "project_selection",
        actionRef: "im_project_selections:expired-selection",
        actions: [{ action_id: "project_0", value: "demo" }],
        actor: { id: "42" }, connectorId: "telegram", conversationId: "-1001",
        expiresAt: "2020-01-01T00:00:00.000Z", interactionId: token, revision: 1, scopeKey: "telegram-thread-4"
      });
      const answers: Array<{ callbackQueryId: string; showAlert?: boolean; text?: string }> = [];
      let resolverCalls = 0;
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      });
      const result = await resolveTelegramInteraction({
        callback: {
          data: encodeTelegramCallbackData({ actionIndex: 0, interactionId: token, revision: 1 }),
          from: { id: 42, is_bot: false }, id: "callback-expired",
          message: { chat: { id: -1001, type: "supergroup" }, date: 1, message_id: 8, message_thread_id: 4 }
        },
        client: {
          answerCallbackQuery: async (input) => { answers.push(input); return true; },
          editMessageReplyMarkup: async () => true,
          getMe: async () => ({ id: 9, is_bot: true }), getUpdates: async () => [],
          getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
          sendMessage: async () => ({ chat: { id: -1001, type: "group" }, date: 1, message_id: 9 }),
          setMessageReaction: async () => true
        },
        config,
        database,
        projectSelection: async () => { resolverCalls += 1; return { ok: true, status: "unexpected" }; }
      });
  
      expect(result.reason).toBe("expired");
      expect(answers).toEqual([{
        callbackQueryId: "callback-expired",
        showAlert: true,
        text: "这个操作已过期，请从最新消息重试。"
      }]);
      expect(resolverCalls).toBe(0);
    });
}
