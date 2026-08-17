import { dirname } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import { localSettingsPath, readLocalSettingsFile, updateLocalSettingsFile } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { TelegramClientError, createTelegramBotClient, type TelegramBotClient } from "../integrations/telegramClient.ts";
import { buildTelegramConnectorConfig, formatTelegramProjectMappings, telegramConnectorStatus } from "../integrations/telegramConfig.ts";
import type { TelegramConnectorConfig, TelegramMessage, TelegramUpdate, TelegramUser } from "../integrations/telegramTypes.ts";
import { createDatabaseSecretService, type SecretService } from "../security/secrets/service.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type Context = {
  config?: RunnerConfig;
  database: RunnerDatabase;
  onConfigChanged?: (config: TelegramConnectorConfig) => Promise<void> | void;
  secrets?: SecretService;
  telegramClientFactory?: (config: TelegramConnectorConfig) => TelegramBotClient;
};

type TelegramSourceCandidate = {
  chat_id: string;
  chat_title: string;
  chat_type: string;
  observed_at: string;
  user_display_name: string;
  user_id: string;
  user_username: string;
};

type LocalSettings = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  botToken: string;
  botTokenRef: string;
  defaultChatId: string;
  enabled: boolean;
  getMeCacheTtlSeconds: number;
  pollTimeoutSeconds: number;
  projectMappings: string;
};

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

function recentTelegramSources(database: RunnerDatabase): TelegramSourceCandidate[] {
  const rows = database.sqlite.query<{ normalized_message_json: string; received_at: string }, []>(
    `select normalized_message_json, received_at from external_events
      where source='telegram' order by id desc limit 100`
  ).all();
  return uniqueSources(rows.flatMap((row) => {
    try {
      const message = JSON.parse(row.normalized_message_json) as Record<string, unknown>;
      const conversation = record(message.conversation);
      const sender = record(message.sender);
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

function sourceCandidates(updates: TelegramUpdate[]): TelegramSourceCandidate[] {
  return uniqueSources([...updates].sort((left, right) => right.update_id - left.update_id).flatMap((update) => {
    const source = update.callback_query?.message ?? update.edited_message ?? update.message;
    const user = update.callback_query?.from ?? source?.from;
    return sourceCandidate(source, user);
  }));
}

function sourceCandidate(message: TelegramMessage | undefined, user: TelegramUser | undefined): TelegramSourceCandidate[] {
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

function uniqueSources(sources: TelegramSourceCandidate[]): TelegramSourceCandidate[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.chat_id}:${source.user_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function safeTelegramId(value: unknown, allowNegative: boolean): string {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!/^-?[1-9]\d*$/.test(candidate)) return "";
  const number = Number(candidate);
  return Number.isSafeInteger(number) && (allowNegative || number > 0) ? candidate : "";
}

function safeObservedAt(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799
    ? new Date(value * 1000).toISOString()
    : "";
}

async function saveSettings(context: Context & { secrets: SecretService }, body: Record<string, unknown>) {
  const path = settingsPath(context);
  const current = localFromConfig(currentConfig(context));
  const next = normalize(body, current);
  const existing = (await readLocalSettingsFile(path)).integrations?.telegram ?? {};
  const persisted: Record<string, unknown> = {
    allowedChatIds: next.allowedChatIds,
    allowedUserIds: next.allowedUserIds,
    defaultChatId: next.defaultChatId,
    enabled: next.enabled,
    getMeCacheTtlSeconds: next.getMeCacheTtlSeconds,
    pollTimeoutSeconds: next.pollTimeoutSeconds,
    projectMappings: next.projectMappings
  };
  const submittedToken = hasOwn(body, "bot_token") ? text(body.bot_token) : "";
  const legacyPlaintextToken = !text(existing.botTokenRef) ? text(existing.botToken) : "";
  const tokenToPersist = submittedToken || legacyPlaintextToken;
  if (tokenToPersist) {
    persisted.botTokenRef = context.secrets.putOrRotate(
      "integrations/telegram/bot-token",
      tokenToPersist,
      "user",
      submittedToken ? "updated Telegram bot token" : "migrated legacy Telegram bot token"
    ).ref;
  } else if (text(existing.botTokenRef)) {
    persisted.botTokenRef = text(existing.botTokenRef);
  }
  const nextConfig = buildTelegramConnectorConfig({
    telegramAllowedChatIds: next.allowedChatIds,
    telegramAllowedUserIds: next.allowedUserIds,
    telegramBotToken: next.botToken,
    telegramBotTokenRef: text(persisted.botTokenRef),
    telegramDefaultChatId: next.defaultChatId,
    telegramEnabled: next.enabled,
    telegramGetMeCacheTtlSeconds: next.getMeCacheTtlSeconds,
    telegramPollTimeoutSeconds: next.pollTimeoutSeconds,
    telegramProjectMappings: next.projectMappings
  });
  Object.assign(persisted, {
    allowedChatIds: nextConfig.allowedChatIds,
    allowedUserIds: nextConfig.allowedUserIds,
    defaultChatId: nextConfig.defaultChatId,
    enabled: nextConfig.enabled,
    getMeCacheTtlSeconds: nextConfig.getMeCacheTtlSeconds,
    pollTimeoutSeconds: nextConfig.pollTimeoutSeconds,
    projectMappings: formatTelegramProjectMappings(nextConfig.projectMappings)
  });
  await updateLocalSettingsFile(path, (settings) => ({
    ...settings,
    integrations: { ...settings.integrations, telegram: persisted }
  }));
  if (context.config) Object.assign(context.config.integrations.telegram, nextConfig);
  createPiActionEvent(context.database, {
    action_id: `telegram-settings:${crypto.randomUUID()}`,
    actor: "user",
    event_type: "connector_settings_updated",
    payload_json: JSON.stringify({
      connector_id: "telegram",
      credential_fields_changed: submittedToken ? ["bot_token"] : [],
      receive_mode: "long_polling"
    }),
    reason: "updated Telegram connector settings",
    result_json: JSON.stringify({ status: "succeeded" })
  });
  await context.onConfigChanged?.(nextConfig);
  return publicSettings(nextConfig, path);
}

function publicSettings(config: TelegramConnectorConfig, path: string): Record<string, unknown> {
  const status = telegramConnectorStatus(config);
  return {
    allowed_chat_ids: config.allowedChatIds,
    allowed_user_ids: config.allowedUserIds,
    bot_token_configured: config.botToken !== "",
    default_chat_id: config.defaultChatId,
    enabled: config.enabled,
    get_me_cache_ttl_seconds: config.getMeCacheTtlSeconds,
    long_polling: true,
    missing_required: status.missing_required,
    poll_timeout_seconds: config.pollTimeoutSeconds,
    project_mappings: formatTelegramProjectMappings(config.projectMappings),
    settings_file: path,
    status: status.status
  };
}

function normalize(body: Record<string, unknown>, current: LocalSettings): LocalSettings {
  return {
    allowedChatIds: hasOwn(body, "allowed_chat_ids") ? list(body.allowed_chat_ids) : current.allowedChatIds,
    allowedUserIds: hasOwn(body, "allowed_user_ids") ? list(body.allowed_user_ids) : current.allowedUserIds,
    botToken: hasOwn(body, "bot_token") && text(body.bot_token) ? text(body.bot_token) : current.botToken,
    botTokenRef: current.botTokenRef,
    defaultChatId: hasOwn(body, "default_chat_id") ? text(body.default_chat_id) : current.defaultChatId,
    enabled: hasOwn(body, "enabled") ? boolean(body.enabled, current.enabled) : current.enabled,
    getMeCacheTtlSeconds: integer(body.get_me_cache_ttl_seconds, current.getMeCacheTtlSeconds, 30, 3600),
    pollTimeoutSeconds: integer(body.poll_timeout_seconds, current.pollTimeoutSeconds, 1, 50),
    projectMappings: hasOwn(body, "project_mappings") ? text(body.project_mappings) : current.projectMappings
  };
}

function localFromConfig(config: TelegramConnectorConfig): LocalSettings {
  return {
    allowedChatIds: config.allowedChatIds,
    allowedUserIds: config.allowedUserIds,
    botToken: config.botToken,
    botTokenRef: config.botTokenRef,
    defaultChatId: config.defaultChatId,
    enabled: config.enabled,
    getMeCacheTtlSeconds: config.getMeCacheTtlSeconds,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    projectMappings: formatTelegramProjectMappings(config.projectMappings)
  };
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function currentConfig(context: Context): TelegramConnectorConfig {
  return context.config?.integrations.telegram ?? buildTelegramConnectorConfig();
}

function settingsPath(context: Context): string {
  return localSettingsPath(context.config?.stateDir || dirname(context.database.path));
}

function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(values.map(text).filter(Boolean))];
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(text(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(text(value).toLowerCase())) return false;
  return fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
