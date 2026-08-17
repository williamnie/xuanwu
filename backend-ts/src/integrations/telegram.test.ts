import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createImInteractionBinding, getImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import { createProject } from "../db/repositories/projects.ts";
import { createTelegramAgentBridge } from "./telegramAgentBridge.ts";
import { buildTelegramConnectorConfig, telegramConnectorStatus } from "./telegramConfig.ts";
import { createTelegramBotClient, TelegramClientError } from "./telegramClient.ts";
import { createTelegramChannelConnector, createTelegramImOutboundEnvelope, splitTelegramText } from "./telegramChannelConnector.ts";
import {
  decodeTelegramCallbackData,
  encodeTelegramCallbackData,
  isTelegramCallbackDataWithinByteLimit
} from "./telegramCallbackCodec.ts";
import { normalizeTelegramMessageUpdate, telegramPrompt } from "./telegramEvents.ts";
import { resolveTelegramInteraction } from "./telegramInteractionAdapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Telegram channel adapter", () => {
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

  test("splits by paragraph then Unicode rune and reuses durable per-part receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-connector-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("retries a split delivery without resending its durable prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-partial-retry-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("pauses only the affected chat after Telegram returns retry_after", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-chat-rate-limit-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("resolves an inline action through the server binding exactly once and clears the keyboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-interaction-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("answers an expired callback once with a stable error before running its resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-expired-interaction-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("routes callback result presentation through the durable IM outbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-interaction-result-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });

  test("reuses one project selection and interaction binding after an outbound retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-selection-retry-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
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
    } finally {
      database.close();
    }
  });
});

function tableCount(database: Awaited<ReturnType<typeof openDatabase>>, table: string): number {
  return database.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
