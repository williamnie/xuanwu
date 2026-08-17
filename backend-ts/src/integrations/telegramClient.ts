import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import type {
  TelegramBotIdentity,
  TelegramConnectorConfig,
  TelegramMessage,
  TelegramUpdate
} from "./telegramTypes.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;

export type TelegramInlineButton = { callback_data: string; text: string };
export type TelegramInlineKeyboard = { inline_keyboard: TelegramInlineButton[][] };

export type TelegramBotClient = {
  answerCallbackQuery(input: { callbackQueryId: string; showAlert?: boolean; text?: string }): Promise<boolean>;
  editMessageReplyMarkup(input: { chatId?: string; inlineMessageId?: string; messageId?: string }): Promise<boolean>;
  getMe(options?: { signal?: AbortSignal }): Promise<TelegramBotIdentity>;
  getUpdates(input: { allowedUpdates: string[]; offset?: number; signal?: AbortSignal; timeoutSeconds: number }): Promise<TelegramUpdate[]>;
  getWebhookInfo(options?: { signal?: AbortSignal }): Promise<{ pending_update_count: number; url: string }>;
  sendMessage(input: {
    chatId: string;
    messageThreadId?: string;
    replyMarkup?: TelegramInlineKeyboard;
    replyToMessageId?: string;
    text: string;
  }): Promise<TelegramMessage>;
  setMessageReaction(input: { chatId: string; messageId: string; reaction: string }): Promise<boolean>;
};

export class TelegramClientError extends Error {
  readonly kind: "auth" | "permanent" | "rate_limited" | "transient";
  readonly retryAfterSeconds?: number;
  readonly status?: number;

  constructor(message: string, options: {
    kind: TelegramClientError["kind"];
    retryAfterSeconds?: number;
    status?: number;
  }) {
    super(message.slice(0, 500));
    this.name = "TelegramClientError";
    this.kind = options.kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.status;
  }
}

export function createTelegramBotClient(options: {
  baseUrl?: string;
  config: TelegramConnectorConfig | (() => TelegramConnectorConfig);
  fetch?: FetchLike;
  requestTimeoutMs?: number;
}): TelegramBotClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = cleanBaseUrl(options.baseUrl ?? "https://api.telegram.org");

  async function call<T>(method: string, body: JsonObject, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const config = typeof options.config === "function" ? options.config() : options.config;
    const token = required(config.botToken, "Telegram bot token is not configured");
    registerSecretForRedaction(token);
    const scoped = timeoutSignal(signal, timeoutMs ?? options.requestTimeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "POST",
        signal: scoped.signal
      });
    } catch (error) {
      scoped.dispose();
      if (signal?.aborted) throw error;
      throw new TelegramClientError("Telegram Bot API request failed", { kind: "transient" });
    }
    scoped.dispose();
    const payload = await responseJson(response);
    if (response.ok && payload.ok === true) return payload.result as T;
    throw telegramError(response, payload);
  }

  return {
    answerCallbackQuery: (input) => call<boolean>("answerCallbackQuery", {
      callback_query_id: required(input.callbackQueryId, "callback query id is required"),
      ...(clean(input.text) ? { text: clean(input.text).slice(0, 200) } : {}),
      ...(input.showAlert ? { show_alert: true } : {})
    }),
    editMessageReplyMarkup: (input) => call<boolean>("editMessageReplyMarkup", {
      ...(clean(input.inlineMessageId) ? { inline_message_id: clean(input.inlineMessageId) } : {
        chat_id: required(input.chatId, "chat id is required"),
        message_id: integerString(input.messageId, "message id")
      }),
      reply_markup: { inline_keyboard: [] }
    }),
    getMe: (input = {}) => call<TelegramBotIdentity>("getMe", {}, input.signal),
    getUpdates: (input) => call<TelegramUpdate[]>("getUpdates", {
      allowed_updates: input.allowedUpdates,
      limit: 100,
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      timeout: input.timeoutSeconds
    }, input.signal, (input.timeoutSeconds + 10) * 1000),
    getWebhookInfo: (input = {}) => call<{ pending_update_count: number; url: string }>("getWebhookInfo", {}, input.signal),
    sendMessage: (input) => call<TelegramMessage>("sendMessage", {
      chat_id: required(input.chatId, "chat id is required"),
      ...(clean(input.messageThreadId) ? { message_thread_id: integerString(input.messageThreadId, "message thread id") } : {}),
      ...(clean(input.replyToMessageId) ? { reply_parameters: { message_id: integerString(input.replyToMessageId, "reply message id") } } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      text: required(input.text, "message text is required")
    }),
    setMessageReaction: (input) => call<boolean>("setMessageReaction", {
      chat_id: required(input.chatId, "chat id is required"),
      message_id: integerString(input.messageId, "message id"),
      reaction: [{ emoji: telegramReaction(input.reaction), type: "emoji" }]
    })
  };
}

function telegramError(response: Response, body: JsonObject): TelegramClientError {
  const status = numeric(body.error_code) ?? response.status;
  const retryAfter = numeric(record(body.parameters).retry_after) ?? retryHeader(response);
  const description = safeDescription(body.description, status);
  return new TelegramClientError(description, {
    kind: status === 401 || status === 403 ? "auth"
      : status === 429 ? "rate_limited"
      : status >= 500 || status === 408 ? "transient"
      : "permanent",
    ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
    status
  });
}

function safeDescription(value: unknown, status: number): string {
  const text = clean(value).replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 320);
  return text ? `Telegram Bot API error (${status}): ${text}` : `Telegram Bot API error (${status})`;
}

function telegramReaction(value: string): string {
  const reaction = clean(value);
  if (["OK", "DONE", "ACK", "THUMBSUP"].includes(reaction.toUpperCase())) return "👍";
  return [...reaction].length <= 4 && reaction !== "" ? reaction : "👍";
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { dispose(): void; signal: AbortSignal } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Telegram request timeout")), Math.max(1, timeoutMs));
  return {
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
    signal: controller.signal
  };
}

async function responseJson(response: Response): Promise<JsonObject> {
  try {
    return record(await response.json());
  } catch {
    return {};
  }
}

function retryHeader(response: Response): number | undefined {
  return numeric(response.headers.get("retry-after"));
}

function numeric(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : undefined;
}

function integerString(value: unknown, label: string): number {
  const number = Number(clean(value));
  if (!Number.isSafeInteger(number)) throw new TelegramClientError(`${label} is invalid`, { kind: "permanent" });
  return number;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function required(value: unknown, message: string): string {
  const text = clean(value);
  if (text === "") throw new TelegramClientError(message, { kind: "permanent" });
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
