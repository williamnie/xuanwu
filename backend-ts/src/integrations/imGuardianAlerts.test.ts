import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import type { GuardianAlertDelivery } from "../pi/guardianAlertDelivery.ts";
import { createBuiltinImChannelRegistry } from "./feishuChannelModule.ts";
import { createImGuardianAlertDelivery } from "./imGuardianAlerts.ts";
import { createTelegramChannelModule } from "./telegramChannelModule.ts";
import type { TelegramBotClient } from "./telegramClient.ts";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("generic IM Guardian alert delivery", () => {
  test("routes a linked Telegram issue alert through the durable generic outbox", async () => {
    const db = await fixture();
    const sent: Array<{ chatId: string; messageThreadId?: string; replyToMessageId?: string; text: string }> = [];
    try {
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "Telegram issue" });
      const event = createExternalEvent(db, {
        content: "check runtime",
        dedupe_key: "telegram:update:901",
        external_id: "901",
        normalized_message: {
          conversation: { id: "-100901", kind: "group" },
          message_id: "901",
          thread: { id: "17" }
        },
        provider: "telegram",
        source: "telegram"
      });
      createExternalLink(db, {
        conversation_id: "telegram-thread-17",
        external_event_id: event.id,
        external_type: "telegram_message",
        issue_id: issue.id,
        project_id: "demo",
        relationship: "origin",
        source: "telegram"
      });
      const config = telegramConfig({ allowedChatIds: ["-100901"] });
      const registry = telegramRegistry(db, config, sent);
      const fallback = fallbackSpy();
      const delivery = createImGuardianAlertDelivery({ database: db, fallback, imChannels: registry, telegramConfig: () => config });
      const alert = upsertPiGuardianAlert(db, {
        alert_type: "pi_runtime_down",
        id: "guardian-telegram-linked",
        issue_id: issue.id,
        message: "runtime unavailable",
        project_id: "demo"
      });

      await delivery.send(alert, { now: new Date("2026-08-16T12:00:00Z") });
      await delivery.send(alert, { now: new Date("2026-08-16T12:01:00Z") });

      expect(fallback.calls).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ chatId: "-100901", messageThreadId: "17", replyToMessageId: "901" });
      expect(sent[0]?.text).toContain("项目 PI Runtime 不可用");
      expect(listSyncOutbox(db, { source: "telegram" })).toMatchObject([
        expect.objectContaining({ status: "sent", target_chat_id: "-100901", target_thread_id: "17" })
      ]);
    } finally {
      db.close();
    }
  });

  test("uses an explicit Telegram project mapping before the Feishu compatibility fallback", async () => {
    const db = await fixture();
    const sent: Array<{ chatId: string; text: string }> = [];
    try {
      const config = telegramConfig({
        allowedChatIds: ["-100902"],
        projectMappings: [{ chatId: "-100902", projectId: "demo" }]
      });
      const fallback = fallbackSpy();
      const delivery = createImGuardianAlertDelivery({
        database: db,
        fallback,
        feishuConfigured: () => true,
        imChannels: telegramRegistry(db, config, sent),
        telegramConfig: () => config
      });
      const alert = upsertPiGuardianAlert(db, {
        alert_type: "approval_fast_path_error",
        id: "guardian-telegram-mapping",
        message: "approval unavailable",
        project_id: "demo"
      });

      await delivery.send(alert);

      expect(fallback.calls).toBe(0);
      expect(sent).toMatchObject([{ chatId: "-100902" }]);
    } finally {
      db.close();
    }
  });

  test("uses the Telegram default chat for system alerts when Feishu is not configured", async () => {
    const db = await fixture();
    const sent: Array<{ chatId: string; text: string }> = [];
    try {
      const config = buildTelegramConnectorConfig({
        allowedChatIds: ["-100903"],
        allowedUserIds: ["42"],
        botToken: "fixture",
        defaultChatId: "-100903",
        enabled: true
      });
      const fallback = fallbackSpy();
      const delivery = createImGuardianAlertDelivery({
        database: db,
        fallback,
        feishuConfigured: () => false,
        imChannels: telegramRegistry(db, config, sent),
        telegramConfig: () => config
      });
      const alert = upsertPiGuardianAlert(db, {
        alert_type: "automation_dead_letter",
        id: "guardian-telegram-default",
        message: "automation stopped",
        project_id: ""
      });

      await delivery.send(alert);

      expect(fallback.calls).toBe(0);
      expect(sent).toMatchObject([{ chatId: "-100903" }]);
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "im-guardian-alerts-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 'codex', ?, ?)`, [
    "2026-08-16T00:00:00Z", "2026-08-16T00:00:00Z"
  ]);
  return db;
}

function telegramConfig(overrides: { allowedChatIds: string[]; projectMappings?: Array<{ chatId: string; projectId: string }> }) {
  return buildTelegramConnectorConfig({
    allowedChatIds: overrides.allowedChatIds,
    allowedUserIds: ["42"],
    botToken: "fixture",
    enabled: true,
    projectMappings: overrides.projectMappings ?? []
  });
}

function telegramRegistry(
  db: RunnerDatabase,
  config: ReturnType<typeof telegramConfig>,
  sent: Array<{ chatId: string; messageThreadId?: string; replyToMessageId?: string; text: string }>
) {
  const module = createTelegramChannelModule({ client: fakeClient(sent), config: () => config, database: db });
  return createBuiltinImChannelRegistry({ telegram: module.module });
}

function fakeClient(sent: Array<{ chatId: string; messageThreadId?: string; replyToMessageId?: string; text: string }>): TelegramBotClient {
  return {
    answerCallbackQuery: async () => true,
    editMessageReplyMarkup: async () => true,
    getMe: async () => ({ id: 9, is_bot: true }),
    getUpdates: async () => [],
    getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
    sendMessage: async (input) => {
      sent.push(input);
      return { chat: { id: Number(input.chatId), type: "supergroup" }, date: 1, message_id: sent.length };
    },
    setMessageReaction: async () => true
  };
}

function fallbackSpy(): GuardianAlertDelivery & { calls: number } {
  return {
    calls: 0,
    connectorID: "feishu",
    async send() { this.calls += 1; }
  };
}
