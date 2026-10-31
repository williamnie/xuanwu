import type { RunnerDatabase } from "../../db/database.ts";
import { TelegramClientError, createTelegramBotClient } from "../../integrations/telegram/telegramClient.ts";
import { telegramConnectorStatus } from "../../integrations/telegram/telegramConfig.ts";
import type { TelegramMessage, TelegramUpdate, TelegramUser } from "../../integrations/telegram/telegramTypes.ts";
import { createDatabaseSecretService } from "../../security/secrets/service.ts";
import { HttpError, json } from "../errors.ts";
import type { Router } from "../router.ts";
import { objectValue } from "../../util/values.ts";
import type { Context, TelegramSourceCandidate } from "./telegramSettingsApi.model.ts";
import { publicSettings, currentConfig, settingsPath, saveSettings, objectBody, text, uniqueSources, safeTelegramId } from "./telegramSettingsApi.saveSettings.ts";

export function registerTelegramSettingsRoutes(router: Router, context: Context): void {
  const active = { ...context, secrets: context.secrets ?? createDatabaseSecretService(context.database) };
  router.get("/api/integrations/telegram/settings", () => json(publicSettings(currentConfig(active), settingsPath(active))));
  router.put("/api/integrations/telegram/settings", async (request) => json(await saveSettings(active, await objectBody(request))));
  router.post("/api/integrations/telegram/test-connection", async () => {
    const config = currentConfig(active);
    if (!telegramConnectorStatus(config).enabled) throw new HttpError(400, "Telegram 配置未启用或缺少 Bot Token");
    const client = createTelegramBotClient({ config });
    const bot = await client.getMe();
    const webhook = await client.getWebhookInfo();
    return json({
      bot: { id: String(bot.id), username: bot.username ?? "" },
      long_polling_ready: webhook.url.trim() === "",
      ok: webhook.url.trim() === "",
      webhook_configured: webhook.url.trim() !== ""
    });
  });
  router.post("/api/integrations/telegram/discover-source", async (request) => {
    const body = await objectBody(request);
    const current = currentConfig(active);
    const submittedToken = text(body.bot_token);
    const token = submittedToken || current.botToken;
    if (!token) throw new HttpError(400, "请先填写 Bot Token");
    const discoveryConfig = { ...current, botToken: token };
    const client = active.telegramClientFactory?.(discoveryConfig) ?? createTelegramBotClient({ config: discoveryConfig });
    try {
      const [bot, webhook] = await Promise.all([client.getMe(), client.getWebhookInfo()]);
      if (webhook.url.trim() !== "") {
        throw new HttpError(409, "Bot 已配置 webhook，请先在 Telegram 侧移除 webhook 后再自动识别");
      }
      const canUseHistory = telegramConnectorStatus(current).enabled &&
        (submittedToken === "" || submittedToken === current.botToken);
      const sources = canUseHistory
        ? recentTelegramSources(active.database)
        : sourceCandidates(await client.getUpdates({
          allowedUpdates: ["message", "edited_message", "callback_query"],
          timeoutSeconds: 0
        }));
      return json({
        bot: { id: String(bot.id), username: bot.username ?? "" },
        long_polling_ready: true,
        mode: canUseHistory ? "recent_events" : "pending_updates",
        ok: true,
        sources
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof TelegramClientError) {
        if (error.kind === "auth") throw new HttpError(400, "Bot Token 无效或 Bot 无权访问 Telegram API");
        if (error.status === 409) throw new HttpError(409, "Bot 正被另一个 long-polling consumer 使用，请先停止冲突实例");
        throw new HttpError(error.kind === "permanent" ? 400 : 502, "Telegram 来源识别失败，请稍后重试");
      }
      throw error;
    }
  });
}

export function recentTelegramSources(database: RunnerDatabase): TelegramSourceCandidate[] {
  const rows = database.sqlite.query<{ normalized_message_json: string; received_at: string }, []>(
    `select normalized_message_json, received_at from external_events
      where source='telegram' order by id desc limit 100`
  ).all();
  return uniqueSources(rows.flatMap((row) => {
    try {
      const message = JSON.parse(row.normalized_message_json) as Record<string, unknown>;
      const conversation = objectValue(message.conversation);
      const sender = objectValue(message.sender);
      if (text(sender.kind) !== "user") return [];
      const chatId = safeTelegramId(conversation.id, true);
      const userId = safeTelegramId(sender.id, false);
      if (!chatId || !userId) return [];
      return [{
        chat_id: chatId,
        chat_title: "",
        chat_type: text(conversation.kind) || "unknown",
        observed_at: text(message.occurred_at) || row.received_at,
        user_display_name: text(sender.display_name),
        user_id: userId,
        user_username: ""
      }];
    } catch {
      return [];
    }
  }));
}

export function sourceCandidates(updates: TelegramUpdate[]): TelegramSourceCandidate[] {
  return uniqueSources([...updates].sort((left, right) => right.update_id - left.update_id).flatMap((update) => {
    const source = update.callback_query?.message ?? update.edited_message ?? update.message;
    const user = update.callback_query?.from ?? source?.from;
    return sourceCandidate(source, user);
  }));
}

export function sourceCandidate(message: TelegramMessage | undefined, user: TelegramUser | undefined): TelegramSourceCandidate[] {
  if (!message || !user || user.is_bot) return [];
  const chatId = safeTelegramId(message.chat.id, true);
  const userId = safeTelegramId(user.id, false);
  if (!chatId || !userId) return [];
  return [{
    chat_id: chatId,
    chat_title: text(message.chat.title) || text(message.chat.username),
    chat_type: text(message.chat.type) || "unknown",
    observed_at: safeObservedAt(message.date),
    user_display_name: [user.first_name, user.last_name].map(text).filter(Boolean).join(" "),
    user_id: userId,
    user_username: text(user.username)
  }];
}

export function safeObservedAt(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799
    ? new Date(value * 1000).toISOString()
    : "";
}
