import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { buildTelegramConnectorConfig } from "./telegramConfig.ts";
import { TelegramClientError } from "./telegramClient.ts";
import { createTelegramReceiverManager } from "./telegramReceiver.ts";
import type { TestFixture } from "./telegramReceiver.testFixture.ts";

export function registerInvalidatesTheGetmeCacheWhenCases(testScope: TestFixture) {
  const { trackDatabase, roots, fakeClient, receiverConfig, pending, waitFor } = testScope;
  test("invalidates the getMe cache when the Bot Token changes", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-token-cache-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let getMeCalls = 0;
      const base = fakeClient([]);
      const manager = createTelegramReceiverManager({
        client: {
          ...base,
          getMe: async () => ({ id: ++getMeCalls, is_bot: true, username: `runner_bot_${getMeCalls}` }),
          getUpdates: async (input) => pending(input.signal)
        },
        database
      });
      const first = buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "token-a"
      });
      await manager.restart(first);
      await manager.restart(first);
      expect(getMeCalls).toBe(1);
      await manager.restart(buildTelegramConnectorConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: "-1001", TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_TOKEN: "token-b"
      }));
      expect(getMeCalls).toBe(2);
      manager.stop();
      database.close();
    });
  
  test("classifies a competing long-poll consumer as permanent and does not reconnect", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-conflict-"));
      roots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      let polls = 0;
      const base = fakeClient([]);
      const manager = createTelegramReceiverManager({
        client: {
          ...base,
          getUpdates: async () => {
            polls += 1;
            throw new TelegramClientError("Telegram Bot API error (409): Conflict", { kind: "permanent", status: 409 });
          }
        },
        database,
        retryBaseMs: 10
      });
      await manager.restart(receiverConfig());
      await waitFor(() => manager.status().state === "failed");
      await Bun.sleep(30);
      expect(manager.status()).toMatchObject({ connected: false, reconnect_attempts: 1, state: "failed" });
      expect(manager.status().last_error).toContain("409");
      expect(polls).toBe(1);
      manager.stop();
      database.close();
    });
}
