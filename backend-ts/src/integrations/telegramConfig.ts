import type {
  TelegramConfigInput,
  TelegramConnectorConfig,
  TelegramProjectMapping
} from "./telegramTypes.ts";

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_GET_ME_CACHE_TTL_SECONDS = 300;

export function buildTelegramConnectorConfig(input: TelegramConfigInput = {}): TelegramConnectorConfig {
  const value = input as Record<string, unknown>;
  const token = first(value.telegramBotToken, value.botToken, value.TELEGRAM_BOT_TOKEN);
  return {
    allowedChatIds: telegramIds(firstValue(value.telegramAllowedChatIds, value.allowedChatIds, value.TELEGRAM_ALLOWED_CHAT_IDS), true),
    allowedUserIds: telegramIds(firstValue(value.telegramAllowedUserIds, value.allowedUserIds, value.TELEGRAM_ALLOWED_USER_IDS), false),
    botToken: token,
    botTokenRef: first(value.telegramBotTokenRef, value.botTokenRef, value.TELEGRAM_BOT_TOKEN_REF),
    defaultChatId: telegramId(first(value.telegramDefaultChatId, value.defaultChatId, value.TELEGRAM_DEFAULT_CHAT_ID), true),
    enabled: booleanValue(firstValue(value.telegramEnabled, value.enabled, value.TELEGRAM_ENABLED), token !== ""),
    getMeCacheTtlSeconds: boundedInteger(
      firstValue(value.telegramGetMeCacheTtlSeconds, value.getMeCacheTtlSeconds, value.TELEGRAM_GET_ME_CACHE_TTL_SECONDS),
      30,
      3600,
      DEFAULT_GET_ME_CACHE_TTL_SECONDS
    ),
    pollTimeoutSeconds: boundedInteger(
      firstValue(value.telegramPollTimeoutSeconds, value.pollTimeoutSeconds, value.TELEGRAM_POLL_TIMEOUT_SECONDS),
      1,
      50,
      DEFAULT_POLL_TIMEOUT_SECONDS
    ),
    projectMappings: projectMappings(firstValue(value.telegramProjectMappings, value.projectMappings, value.TELEGRAM_PROJECT_MAPPINGS)),
    receiveMode: "long_polling"
  };
}

export function telegramConnectorStatus(config: TelegramConnectorConfig): {
  enabled: boolean;
  missing_required: string[];
  status: "configured" | "disabled" | "misconfigured";
} {
  const missing = config.enabled ? [
    ...(clean(config.botToken) === "" ? ["TELEGRAM_BOT_TOKEN"] : []),
    ...(config.allowedChatIds.length === 0 ? ["TELEGRAM_ALLOWED_CHAT_IDS"] : []),
    ...(config.allowedUserIds.length === 0 ? ["TELEGRAM_ALLOWED_USER_IDS"] : [])
  ] : [];
  return {
    enabled: config.enabled && missing.length === 0,
    missing_required: missing,
    status: !config.enabled ? "disabled" : missing.length > 0 ? "misconfigured" : "configured"
  };
}

export function formatTelegramProjectMappings(mappings: TelegramProjectMapping[]): string {
  return mappings.map((item) => `${item.chatId ? `chat:${item.chatId}` : `user:${item.userId ?? ""}`}=${item.projectId}`).join(",");
}

function projectMappings(value: unknown): TelegramProjectMapping[] {
  const items = Array.isArray(value) ? value : list(value);
  return items.map((item) => typeof item === "string" ? parseMapping(item) : normalizeMapping(item)).filter(
    (item): item is TelegramProjectMapping => item !== null
  );
}

function parseMapping(value: string): TelegramProjectMapping | null {
  const separator = value.indexOf("=");
  if (separator <= 0) return null;
  const target = value.slice(0, separator).trim();
  const projectId = value.slice(separator + 1).trim();
  if (projectId === "") return null;
  if (target.startsWith("user:")) {
    const userId = telegramId(target.slice(5), false);
    return userId ? { projectId, userId } : null;
  }
  const chatId = telegramId(target.startsWith("chat:") ? target.slice(5) : target, true);
  return chatId ? { chatId, projectId } : null;
}

function normalizeMapping(value: unknown): TelegramProjectMapping | null {
  const item = record(value);
  const projectId = clean(item.projectId);
  const chatId = telegramId(item.chatId, true);
  const userId = telegramId(item.userId, false);
  if (projectId === "" || (chatId === "" && userId === "")) return null;
  return { ...(chatId ? { chatId } : {}), projectId, ...(userId ? { userId } : {}) };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : fallback;
}

function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(values.map(clean).filter(Boolean))];
}

function telegramIds(value: unknown, allowNegative: boolean): string[] {
  return [...new Set(list(value).map((item) => telegramId(item, allowNegative)).filter(Boolean))];
}

function telegramId(value: unknown, allowNegative: boolean): string {
  const text = clean(value);
  if (!/^-?[1-9]\d*$/.test(text)) return "";
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number === 0 || (!allowNegative && number < 0)) return "";
  return text;
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value);
    if (text !== "") return text;
  }
  return "";
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
