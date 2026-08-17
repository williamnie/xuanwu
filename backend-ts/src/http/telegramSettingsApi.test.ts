import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildConfig, ENV_KEYS, loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import type { TelegramBotClient } from "../integrations/telegramClient.ts";
import { registerTelegramSettingsRoutes } from "./telegramSettingsApi.ts";
import { createRouter } from "./router.ts";
import { createDefaultRouter } from "./server.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Telegram settings API", () => {
  test("discovers Chat and User IDs from a pending private message without persisting or echoing the Token", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-discovery-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      const calls: string[] = [];
      const client = {
        getMe: async () => { calls.push("getMe"); return { id: 9001, is_bot: true, username: "fixture_bot" }; },
        getWebhookInfo: async () => { calls.push("getWebhookInfo"); return { pending_update_count: 1, url: "" }; },
        getUpdates: async () => {
          calls.push("getUpdates");
          return [{
            message: {
              chat: { id: 42, type: "private" },
              date: 1_700_000_000,
              from: { first_name: "Fixture", id: 42, is_bot: false, username: "fixture_user" },
              message_id: 7,
              text: "/start"
            },
            update_id: 101
          }];
        }
      } as TelegramBotClient;
      const router = createRouter();
      registerTelegramSettingsRoutes(router, {
        config: buildConfig({ dbPath: database.path, stateDir: dirname(database.path) }),
        database,
        telegramClientFactory: () => client
      });

      const response = await router.handle(new Request("http://127.0.0.1/api/integrations/telegram/discover-source", {
        body: JSON.stringify({ bot_token: "123:discovery-secret" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(calls.sort()).toEqual(["getMe", "getUpdates", "getWebhookInfo"].sort());
      expect(body).toMatchObject({
        bot: { id: "9001", username: "fixture_bot" },
        mode: "pending_updates",
        ok: true,
        sources: [{
          chat_id: "42",
          chat_type: "private",
          user_display_name: "Fixture",
          user_id: "42",
          user_username: "fixture_user"
        }]
      });
      expect(JSON.stringify(body)).not.toContain("discovery-secret");
      expect(await readFile(join(dirname(database.path), "runner-settings.local.json"), "utf8").catch(() => "")).toBe("");
    } finally {
      database.close();
    }
  });

  test("uses durable recent events instead of competing with an active long-poll receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-discovery-active-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      Object.assign(config.integrations.telegram, {
        allowedChatIds: ["42"],
        allowedUserIds: ["42"],
        botToken: "123:active-secret",
        defaultChatId: "42",
        enabled: true
      });
      database.sqlite.run(
        `insert into external_events (source, content, dedupe_key, normalized_message_json)
         values ('telegram', ?, 'telegram:update:201', ?)`,
        ["private message must not be returned", JSON.stringify({
          conversation: { id: "42", kind: "direct" },
          occurred_at: "2026-08-16T10:00:00.000Z",
          sender: { display_name: "Fixture User", id: "42", kind: "user" },
          text: "private message must not be returned"
        })]
      );
      let polled = false;
      const client = {
        getMe: async () => ({ id: 9001, is_bot: true, username: "fixture_bot" }),
        getWebhookInfo: async () => ({ pending_update_count: 0, url: "" }),
        getUpdates: async () => { polled = true; return []; }
      } as TelegramBotClient;
      const router = createRouter();
      registerTelegramSettingsRoutes(router, { config, database, telegramClientFactory: () => client });

      const response = await router.handle(new Request("http://127.0.0.1/api/integrations/telegram/discover-source", {
        body: JSON.stringify({}), headers: { "content-type": "application/json" }, method: "POST"
      }));
      const bodyText = await response.text();
      const body = JSON.parse(bodyText);

      expect(response.status).toBe(200);
      expect(polled).toBe(false);
      expect(body).toMatchObject({ mode: "recent_events", sources: [{ chat_id: "42", user_id: "42" }] });
      expect(bodyText).not.toContain("private message must not be returned");
      expect(bodyText).not.toContain("active-secret");
    } finally {
      database.close();
    }
  });

  test("stores Bot Token through SecretService and never reads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-settings-"));
    roots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const router = createDefaultRouter({ config, database });
      const response = await router.handle(new Request("http://127.0.0.1/api/integrations/telegram/settings", {
        body: JSON.stringify({
          allowed_chat_ids: "-1001", allowed_user_ids: "42", bot_token: "123:secret",
          default_chat_id: "-1001", enabled: true, poll_timeout_seconds: 20,
          project_mappings: "chat:-1001=demo"
        }),
        headers: { "content-type": "application/json" }, method: "PUT"
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ bot_token_configured: true, enabled: true, status: "configured" });
      expect(JSON.stringify(body)).not.toContain("123:secret");
      const settings = await readFile(join(dirname(database.path), "runner-settings.local.json"), "utf8");
      expect(settings).toContain("secret://integrations/telegram/bot-token");
      expect(settings).not.toContain("123:secret");
      const reloaded = loadConfig([], { [ENV_KEYS.stateDir]: dirname(database.path) });
      expect(reloaded.integrations.telegram.botToken).toBe("123:secret");
    } finally {
      database.close();
    }
  });

  test("migrates a legacy plaintext Bot Token into SecretService on the next settings save", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-settings-legacy-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    try {
      const settingsPath = join(stateDir, "runner-settings.local.json");
      await writeFile(settingsPath, JSON.stringify({
        integrations: {
          telegram: {
            allowedChatIds: ["-1001"],
            allowedUserIds: ["42"],
            botToken: "123:legacy-secret",
            enabled: true
          }
        }
      }), { mode: 0o600 });
      const config = loadConfig([], { [ENV_KEYS.stateDir]: stateDir });
      const router = createDefaultRouter({ config, database });
      const response = await router.handle(new Request("http://127.0.0.1/api/integrations/telegram/settings", {
        body: JSON.stringify({ poll_timeout_seconds: 20 }),
        headers: { "content-type": "application/json" }, method: "PUT"
      }));

      expect(response.status).toBe(200);
      const settings = await readFile(settingsPath, "utf8");
      expect(settings).toContain("secret://integrations/telegram/bot-token");
      expect(settings).not.toContain("123:legacy-secret");
      expect(loadConfig([], { [ENV_KEYS.stateDir]: stateDir }).integrations.telegram.botToken).toBe("123:legacy-secret");
    } finally {
      database.close();
    }
  });

  test("persists only normalized Telegram IDs and mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-telegram-settings-normalized-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    try {
      const config = buildConfig({ dbPath: database.path, stateDir });
      const router = createDefaultRouter({ config, database });
      const response = await router.handle(new Request("http://127.0.0.1/api/integrations/telegram/settings", {
        body: JSON.stringify({
          allowed_chat_ids: "bad,-1001",
          allowed_user_ids: "nope,42",
          bot_token: "123:secret",
          default_chat_id: "not-a-chat",
          enabled: true,
          project_mappings: "chat:bad=nope,chat:-1001=demo,user:42=demo"
        }),
        headers: { "content-type": "application/json" }, method: "PUT"
      }));
      const body = await response.json();
      expect(body).toMatchObject({
        allowed_chat_ids: ["-1001"],
        allowed_user_ids: ["42"],
        default_chat_id: "",
        project_mappings: "chat:-1001=demo,user:42=demo",
        status: "configured"
      });
      const settings = JSON.parse(await readFile(join(stateDir, "runner-settings.local.json"), "utf8"));
      expect(settings.integrations.telegram).toMatchObject({
        allowedChatIds: ["-1001"],
        allowedUserIds: ["42"],
        defaultChatId: "",
        projectMappings: "chat:-1001=demo,user:42=demo"
      });
    } finally {
      database.close();
    }
  });
});
