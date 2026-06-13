import type { FeishuConnectorConfig } from "./feishu.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuReceiveIdType = "chat_id" | "email" | "open_id" | "union_id" | "user_id";
export type FeishuTextMessageInput = { receiveId: string; receiveIdType: FeishuReceiveIdType | string; text: string };
export type FeishuInteractiveCardInput = { card: Record<string, unknown>; receiveId: string; receiveIdType: FeishuReceiveIdType | string };
export type FeishuTextMessageResult = { messageId: string };
export type FeishuMessageClient = {
  sendInteractiveCard?(input: FeishuInteractiveCardInput): Promise<FeishuTextMessageResult>;
  sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult>;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ClientOptions = { baseUrl?: string; config: FeishuConnectorConfig; fetch?: FetchLike; now?: () => Date };
type TokenCache = { expiresAtMs: number; token: string };
type ErrorKind = "auth" | "permanent" | "rate_limited" | "temporary";
type FeishuApiBody = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class FeishuClientError extends Error {
  readonly kind: ErrorKind;
  readonly retryAfterSeconds?: number;
  readonly status?: number;

  constructor(message: string, options: { kind: ErrorKind; retryAfterSeconds?: number; status?: number }) {
    super(redactSensitiveText(message));
    this.name = "FeishuClientError";
    this.kind = options.kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.status;
  }
}

export function createFeishuMessageClient(options: ClientOptions): FeishuMessageClient {
  return new DefaultFeishuMessageClient(options);
}

class DefaultFeishuMessageClient implements FeishuMessageClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private tokenCache: TokenCache | null = null;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = cleanBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult> {
    const text = requireText(input.text, "text");
    return this.sendMessage(input, "text", JSON.stringify({ text }));
  }

  async sendInteractiveCard(input: FeishuInteractiveCardInput): Promise<FeishuTextMessageResult> {
    return this.sendMessage(input, "interactive", JSON.stringify(input.card));
  }

  private async sendMessage(
    input: { receiveId: string; receiveIdType: FeishuReceiveIdType | string },
    messageType: string,
    content: string
  ): Promise<FeishuTextMessageResult> {
    const receiveId = requireText(input.receiveId, "receiveId");
    const receiveIdType = requireText(input.receiveIdType, "receiveIdType");
    const token = await this.tenantAccessToken();
    const response = await this.postJson(`/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
      content,
      msg_type: messageType,
      receive_id: receiveId
    }, { Authorization: `Bearer ${token}` });
    const messageId = cleanString(objectBody(response.body).message_id ?? objectBody(response.body.data).message_id);
    if (messageId === "") throw new FeishuClientError("Feishu send message response missing message_id", { kind: "temporary", status: response.status });
    return { messageId };
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAtMs > this.now().getTime() + TOKEN_REFRESH_SKEW_MS) return this.tokenCache.token;
    const appId = requireText(this.options.config.appId, "FEISHU_APP_ID");
    const appSecret = requireText(this.options.config.appSecret, "FEISHU_APP_SECRET");
    const response = await this.postJson("/open-apis/auth/v3/tenant_access_token/internal", { app_id: appId, app_secret: appSecret });
    const token = requireText(response.body.tenant_access_token, "tenant_access_token");
    const expireSeconds = positiveNumber(response.body.expire) || 7200;
    this.tokenCache = { expiresAtMs: this.now().getTime() + expireSeconds * 1000, token };
    return token;
  }

  private async postJson(path: string, body: FeishuApiBody, headers: Record<string, string> = {}) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        method: "POST"
      });
    } catch (error) {
      throw new FeishuClientError(`Feishu request failed: ${safeError(error, this.options.config)}`, { kind: "temporary" });
    }
    return await parseFeishuResponse(response, this.options.config);
  }
}

async function parseFeishuResponse(
  response: Response,
  config: FeishuConnectorConfig
): Promise<{ body: FeishuApiBody; status: number }> {
  const body = await responseBody(response);
  const code = numericCode(body.code);
  if (response.ok && (code === undefined || code === 0)) return { body, status: response.status };
  throw new FeishuClientError(sanitizeText(errorMessage(body, response), config), {
    kind: errorKind(response, code),
    retryAfterSeconds: retryAfterSeconds(response),
    status: response.status
  });
}

async function responseBody(response: Response): Promise<FeishuApiBody> {
  try {
    const parsed = await response.json() as unknown;
    return objectBody(parsed);
  } catch {
    return {};
  }
}

function errorKind(response: Response, code: number | undefined): ErrorKind {
  if (response.status === 429) return "rate_limited";
  if (response.status === 401 || response.status === 403) return "auth";
  if (response.status >= 500) return "temporary";
  if (code === 99991663) return "auth";
  return "permanent";
}

function errorMessage(body: FeishuApiBody, response: Response): string {
  const msg = cleanString(body.msg ?? body.message) || response.statusText || "Feishu API error";
  return `Feishu API error (${response.status}): ${msg}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after") ?? "");
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function objectBody(value: unknown): FeishuApiBody {
  return value && typeof value === "object" && !Array.isArray(value) ? value as FeishuApiBody : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function requireText(value: unknown, name: string): string {
  const text = cleanString(value);
  if (text === "") throw new FeishuClientError(`${name} is required`, { kind: "permanent" });
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown, config: FeishuConnectorConfig): string {
  return sanitizeText(error instanceof Error ? error.message : String(error), config);
}

function sanitizeText(text: string, config: FeishuConnectorConfig): string {
  return [config.appSecret, config.encryptKey, config.verificationToken].reduce(
    (current, secret) => replaceSecret(current, secret),
    redactSensitiveText(text)
  );
}

function replaceSecret(text: string, secret: string): string {
  const value = secret.trim();
  return value === "" ? text : text.split(value).join("[redacted]");
}
