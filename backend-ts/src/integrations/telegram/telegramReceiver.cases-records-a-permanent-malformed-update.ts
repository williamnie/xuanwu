import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { listExternalEvents } from "../../db/repositories/externalEvents.ts";
import { getConnectorCursor } from "../../db/repositories/connectorRuntime.ts";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";
import { type TelegramBotClient } from "./telegramClient.ts";
import { createTelegramReceiverManager } from "./telegramReceiver.ts";
import type { TestFixture } from "./telegramReceiver.testFixture.ts";

export function registerRecordsAPermanentMalformedUpdateCases(testScope: TestFixture) {
  const { trackDatabase, roots, fakeClient, batchClient, receiverConfig, pending, waitFor } = testScope;
  test("records a permanent malformed update and continues the durable batch prefix", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-poison-update-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let emitted = false;
      let deliveries = 0;
      const client: TelegramBotClient = {
        ...fakeClient([]),
        getUpdates: async (input) => {
          if (emitted) return pending(input.signal);
          emitted = true;
          return [{
            message: { chat: { id: -1001, type: "supergroup" }, date: 1_700_000_000, message_id: 104, text: "missing sender" },
            update_id: 104
          }, {
            message: {
              chat: { id: -1001, type: "supergroup" }, date: 1_700_000_000,
              from: { id: 42, is_bot: false }, message_id: 105, text: "valid"
            },
            update_id: 105
          }];
        }
      };
      const manager = createTelegramReceiverManager({
        client,
        database,
        onMessage: async () => { deliveries += 1; }
      });
      await manager.restart(receiverConfig());
      await waitFor(() => getConnectorCursor(database, "telegram", "bot-updates")?.position === "105");
  
      expect(deliveries).toBe(1);
      expect(database.sqlite.query<{ outcome: string; update_id: string }, []>(
        "select update_id, outcome from connector_update_audits order by cast(update_id as integer)"
      ).all()).toEqual([
        { outcome: "rejected", update_id: "104" },
        { outcome: "accepted", update_id: "105" }
      ]);
      manager.stop();
      database.close();
    });
  
  test("stops a batch at a non-durable update and resumes from the contiguous cursor", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-batch-prefix-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const offsets: Array<number | undefined> = [];
      let deliveries = 0;
      database.sqlite.run(`create trigger reject_telegram_102 before insert on connector_update_audits
      when new.connector_id='telegram' and new.update_id='102'
      begin select raise(abort, 'fixture audit failure'); end`);
      const first = createTelegramReceiverManager({
        client: batchClient(offsets),
        database,
        onMessage: async () => { deliveries += 1; },
        retryBaseMs: 50
      });
      await first.restart(receiverConfig());
      await waitFor(() => getConnectorCursor(database, "telegram", "bot-updates")?.position === "101");
      await Bun.sleep(20);
      expect(deliveries).toBe(1);
      expect(listExternalEvents(database, { source: "telegram" }).map((event) => event.external_id)).toEqual(["101"]);
      first.stop();
  
      database.sqlite.run("drop trigger reject_telegram_102");
      const restarted = createTelegramReceiverManager({
        client: batchClient(offsets),
        database,
        onMessage: async () => { deliveries += 1; },
        retryBaseMs: 10
      });
      await restarted.restart(receiverConfig());
      await waitFor(() => getConnectorCursor(database, "telegram", "bot-updates")?.position === "103");
  
      expect(offsets).toContain(102);
      expect(deliveries).toBe(3);
      expect(listExternalEvents(database, { source: "telegram" }).map((event) => event.external_id).sort()).toEqual(["101", "102", "103"]);
      restarted.stop();
      database.close();
    });
  
  test("commits the accepted update and cursor together and skips it after restart", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-receiver-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const offsets: Array<number | undefined> = [];
      let deliveries = 0;
      const manager = createTelegramReceiverManager({
        client: fakeClient(offsets), database,
        onMessage: async () => { deliveries += 1; },
        retryBaseMs: 10
      });
      const config = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      });
      await manager.restart(config);
      await waitFor(() => getConnectorCursor(database, "telegram", "bot-updates")?.position === "10");
      expect(deliveries).toBe(1);
      expect(listExternalEvents(database, { source: "telegram" })).toHaveLength(1);
      expect(offsets[0]).toBeUndefined();
      manager.stop();
  
      const restarted = createTelegramReceiverManager({
        client: fakeClient(offsets), database,
        onMessage: async () => { deliveries += 1; },
        retryBaseMs: 10
      });
      await restarted.restart(config);
      await waitFor(() => offsets.includes(11));
      await Bun.sleep(20);
      expect(deliveries).toBe(1);
      restarted.stop();
      database.close();
    });
  
  test("does not execute the same accepted message twice when its downstream handler fails", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-handler-failure-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const offsets: Array<number | undefined> = [];
      let deliveries = 0;
      const manager = createTelegramReceiverManager({
        client: fakeClient(offsets),
        database,
        onMessage: async () => {
          deliveries += 1;
          throw new Error("downstream reply failed");
        },
        retryBaseMs: 10
      });
      await manager.restart(buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      }));
      await waitFor(() => offsets.includes(11));
      expect(getConnectorCursor(database, "telegram", "bot-updates")?.position).toBe("10");
      expect(listExternalEvents(database, { source: "telegram" })).toHaveLength(1);
      expect(deliveries).toBe(1);
      manager.stop();
      database.close();
    });
  
  test("records edited_message in the inbox and audit without invoking PI", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-edited-message-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let emitted = false;
      let deliveries = 0;
      const manager = createTelegramReceiverManager({
        client: {
          ...fakeClient([]),
          getUpdates: async (input) => {
            if (emitted) return pending(input.signal);
            emitted = true;
            return [{
              edited_message: {
                chat: { id: -1001, type: "supergroup" },
                date: 1_700_000_000,
                from: { id: 42, is_bot: false },
                message_id: 5,
                text: "edited content"
              },
              update_id: 20
            }];
          }
        },
        database,
        onMessage: async () => { deliveries += 1; }
      });
  
      await manager.restart(receiverConfig());
      await waitFor(() => getConnectorCursor(database, "telegram", "bot-updates")?.position === "20");
  
      const events = listExternalEvents(database, { source: "telegram" });
      expect(deliveries).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ content: "edited content", external_id: "5", status: "ignored" });
      expect(events[0]?.summary).toMatchObject({ edited: true, message_id: "5" });
      expect(database.sqlite.query<{ outcome: string; reason: string }, []>(
        "select outcome, reason from connector_update_audits where update_id='20'"
      ).get()).toEqual({ outcome: "edited", reason: "edited_message_recorded_without_pi_replay" });
      manager.stop();
      database.close();
    });
  
  test("fails closed without polling when a webhook owns the bot", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-webhook-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let polls = 0;
      const base = fakeClient([]);
      const manager = createTelegramReceiverManager({
        client: {
          ...base,
          getUpdates: async () => { polls += 1; return []; },
          getWebhookInfo: async () => ({ pending_update_count: 1, url: "https://example.test/hook" })
        },
        database
      });
      await manager.restart(buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "fixture"
      }));
      expect(manager.status()).toMatchObject({ connected: false, state: "failed" });
      expect(manager.status().last_error).toContain("webhook is configured");
      expect(polls).toBe(0);
      manager.stop();
      database.close();
    });
}
