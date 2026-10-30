import { expect, test } from "bun:test";
import { buildTelegramConnectorConfig, telegramConnectorStatus } from "./telegramConfig.ts";
import { createTelegramBotClient, TelegramClientError } from "./telegramClient.ts";
import { decodeTelegramCallbackData, encodeTelegramCallbackData, isTelegramCallbackDataWithinByteLimit } from "./telegramCallbackCodec.ts";
import { normalizeTelegramMessageUpdate, telegramPrompt } from "./telegramEvents.ts";
import type { TestFixture } from "./telegram.testFixture.ts";

export function registerParsesFailClosedConfigAndCases(testScope: TestFixture) {
  void testScope;
  test("parses fail-closed config and normalizes ids, mentions, commands and Unix seconds", () => {
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001",
        TELEGRAM_ALLOWED_USER_IDS: "42",
        TELEGRAM_BOT_TOKEN: "fixture-token",
        TELEGRAM_PROJECT_MAPPINGS: "chat:-1001=demo"
      });
      expect(telegramConnectorStatus(config)).toEqual({ enabled: true, missing_required: [], status: "configured" });
      const normalized = normalizeTelegramMessageUpdate({
        bot: { id: 99, is_bot: true, username: "runner_bot" },
        config,
        update: {
          message: {
            chat: { id: -1001, type: "supergroup" },
            date: 1_700_000_000,
            entities: [{ length: 11, offset: 0, type: "mention" }],
            from: { first_name: "User", id: 42, is_bot: false },
            message_id: 7,
            message_thread_id: 8,
            text: "@runner_bot hello"
          },
          update_id: 12
        }
      });
      expect(normalized.message).toMatchObject({
        conversation: { id: "-1001", kind: "group" },
        message_id: "7",
        occurred_at: "2023-11-14T22:13:20.000Z",
        sender: { id: "42", kind: "user" },
        thread: { id: "8" },
        update_id: "12"
      });
      expect(normalized.prompt).toBe("hello");
      expect(normalized.attention.decision).toBe("inbox_only");
      expect(telegramPrompt("/new@runner_bot continue", "runner_bot")).toBe("/new continue");
    });
  
  test("drops malformed or unsafe Telegram IDs from config and project mappings", () => {
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "abc,-1001,9007199254740992",
        TELEGRAM_ALLOWED_USER_IDS: "-42,42,user",
        TELEGRAM_BOT_TOKEN: "fixture-token",
        TELEGRAM_DEFAULT_CHAT_ID: "not-a-chat",
        TELEGRAM_PROJECT_MAPPINGS: "chat:nope=bad,chat:-1001=demo,user:-42=bad,user:42=demo"
      });
  
      expect(config.allowedChatIds).toEqual(["-1001"]);
      expect(config.allowedUserIds).toEqual(["42"]);
      expect(config.defaultChatId).toBe("");
      expect(config.projectMappings).toEqual([
        { chatId: "-1001", projectId: "demo" },
        { projectId: "demo", userId: "42" }
      ]);
    });
  
  test("rejects an unauthorized Telegram chat or user even when the Bot is mentioned", () => {
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001",
        TELEGRAM_ALLOWED_USER_IDS: "42",
        TELEGRAM_BOT_TOKEN: "fixture-token"
      });
      const normalize = (chatId: number, userId: number) => normalizeTelegramMessageUpdate({
        bot: { id: 99, is_bot: true, username: "runner_bot" },
        config,
        update: {
          message: {
            chat: { id: chatId, type: "supergroup" },
            date: 1_700_000_000,
            entities: [{ length: 11, offset: 0, type: "mention" }],
            from: { id: userId, is_bot: false },
            message_id: 7,
            text: "@runner_bot run this"
          },
          update_id: 12
        }
      }).attention;
  
      expect(normalize(-1001, 43)).toMatchObject({ decision: "ignore", reason: "telegram_source_not_allowed" });
      expect(normalize(-1002, 42)).toMatchObject({ decision: "ignore", reason: "telegram_source_not_allowed" });
      expect(normalize(-1001, 42)).toMatchObject({ decision: "inbox_only", reason: "trusted_message_forwarded_to_pi" });
    });
  
  test("fails closed on malformed provider-owned Telegram IDs", () => {
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture-token"
      });
      expect(() => normalizeTelegramMessageUpdate({
        bot: { id: 99, is_bot: true, username: "runner_bot" },
        config,
        update: {
          message: {
            chat: { id: "not-a-chat", type: "supergroup" },
            date: 1_700_000_000,
            from: { id: 42, is_bot: false },
            message_id: 7,
            text: "hello"
          },
          update_id: 12
        }
      })).toThrow("telegram chat id is invalid");
    });
  
  test("normalizes anonymous sender_chat and bounded attachment metadata without binary content", () => {
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture-token"
      });
      const normalized = normalizeTelegramMessageUpdate({
        bot: { id: 99, is_bot: true, username: "runner_bot" },
        config,
        update: {
          message: {
            chat: { id: -1001, type: "supergroup" },
            date: 1_700_000_000,
            document: {
              file_id: "file-1",
              file_name: "a".repeat(600),
              file_size: -1,
              mime_type: "application/octet-stream"
            },
            message_id: 7,
            sender_chat: { id: -1001, title: "Anonymous Admin", type: "supergroup" }
          },
          update_id: 12
        }
      });
  
      expect(normalized.message.sender).toMatchObject({ id: "-1001", kind: "chat" });
      expect(normalized.message.attachments).toEqual([{
        id: "file-1",
        kind: "file",
        mime_type: "application/octet-stream",
        name: "a".repeat(512)
      }]);
      expect(normalized.attention.decision).toBe("inbox_only");
      expect(() => normalizeTelegramMessageUpdate({
        bot: { id: 99, is_bot: true },
        config,
        update: {
          message: { chat: { id: -1001, type: "group" }, date: Number.MAX_SAFE_INTEGER, from: { id: 42, is_bot: false }, message_id: 8 },
          update_id: 13
        }
      })).toThrow("telegram message date is invalid");
    });
  
  test("encodes only opaque callback tokens within Telegram's byte bound", () => {
      const encoded = encodeTelegramCallbackData({ actionIndex: 35, interactionId: "abcdefghijklmnopqrstuv", revision: 9 });
      expect(encoded).toBe("i1.abcdefghijklmnopqrstuv.z.9");
      expect(decodeTelegramCallbackData(encoded)).toEqual({ actionIndex: 35, interactionId: "abcdefghijklmnopqrstuv", revision: 9 });
      expect(decodeTelegramCallbackData("approve:issue:7")).toBeNull();
      expect(isTelegramCallbackDataWithinByteLimit("a")).toBe(true);
      const exactLimit = encodeTelegramCallbackData({ actionIndex: 0, interactionId: "a".repeat(57), revision: 1 });
      expect(new TextEncoder().encode(exactLimit)).toHaveLength(64);
      expect(isTelegramCallbackDataWithinByteLimit(exactLimit)).toBe(true);
      expect(decodeTelegramCallbackData(exactLimit)).toEqual({ actionIndex: 0, interactionId: "a".repeat(57), revision: 1 });
      expect(isTelegramCallbackDataWithinByteLimit(`${exactLimit}a`)).toBe(false);
      expect(decodeTelegramCallbackData(`${exactLimit}a`)).toBeNull();
      expect(() => encodeTelegramCallbackData({ actionIndex: 0, interactionId: "a".repeat(58), revision: 1 })).toThrow("64 bytes");
    });
  
  test("uses plain Bot API JSON, maps retry metadata and never exposes the token in errors", async () => {
      const calls: Array<{ body: Record<string, unknown>; url: string }> = [];
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "1", TELEGRAM_ALLOWED_USER_IDS: "2", TELEGRAM_BOT_TOKEN: "123:fixture-secret"
      });
      const client = createTelegramBotClient({
        config,
        fetch: async (input, init) => {
          calls.push({ body: JSON.parse(String(init?.body)), url: String(input) });
          return Response.json({ ok: true, result: { chat: { id: 1, type: "private" }, date: 1, message_id: 3 } });
        }
      });
      await client.sendMessage({ chatId: "1", messageThreadId: "4", replyToMessageId: "2", text: "<plain>" });
      expect(calls[0]?.body).toMatchObject({ chat_id: "1", message_thread_id: 4, reply_parameters: { message_id: 2 }, text: "<plain>" });
      expect(calls[0]?.body).not.toHaveProperty("parse_mode");
  
      const failing = createTelegramBotClient({
        config,
        fetch: async () => Response.json({ description: "Too Many Requests", error_code: 429, ok: false, parameters: { retry_after: 7 } }, { status: 429 })
      });
      try {
        await failing.getMe();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TelegramClientError);
        expect(error).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 7 });
        expect(String(error)).not.toContain("123:fixture-secret");
      }
    });
}
