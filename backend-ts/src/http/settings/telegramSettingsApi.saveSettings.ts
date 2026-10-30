import { dirname } from "node:path";
import { localSettingsPath, readLocalSettingsFile, updateLocalSettingsFile } from "../../config/localSettings.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { buildTelegramConnectorConfig, formatTelegramProjectMappings, telegramConnectorStatus } from "../../integrations/telegram/telegramConfig.ts";
import type { TelegramConnectorConfig } from "../../integrations/telegram/telegramTypes.ts";
import { type SecretService } from "../../security/secrets/service.ts";
import { HttpError, parseJsonBody } from "../errors.ts";
import type { TelegramSourceCandidate, Context, LocalSettings } from "./telegramSettingsApi.model.ts";

export function uniqueSources(sources: TelegramSourceCandidate[]): TelegramSourceCandidate[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.chat_id}:${source.user_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

export function safeTelegramId(value: unknown, allowNegative: boolean): string {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!/^-?[1-9]\d*$/.test(candidate)) return "";
  const number = Number(candidate);
  return Number.isSafeInteger(number) && (allowNegative || number > 0) ? candidate : "";
}

export async function saveSettings(context: Context & { secrets: SecretService }, body: Record<string, unknown>) {
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

export function publicSettings(config: TelegramConnectorConfig, path: string): Record<string, unknown> {
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

export function normalize(body: Record<string, unknown>, current: LocalSettings): LocalSettings {
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

export function localFromConfig(config: TelegramConnectorConfig): LocalSettings {
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

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

export function currentConfig(context: Context): TelegramConnectorConfig {
  return context.config?.integrations.telegram ?? buildTelegramConnectorConfig();
}

export function settingsPath(context: Context): string {
  return localSettingsPath(context.config?.stateDir || dirname(context.database.path));
}

export function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(values.map(text).filter(Boolean))];
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

export function boolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(text(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(text(value).toLowerCase())) return false;
  return fallback;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
