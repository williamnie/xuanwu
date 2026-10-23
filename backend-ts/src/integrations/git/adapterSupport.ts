import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { redactedUserVisibleText } from "../../util/redact.ts";
import {
  RemoteGitIdempotencyConflictError,
  type RemoteGitMutationResponse,
  type RemoteGitOperation
} from "./remoteProvider.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RemoteGitConnectorConfig = {
  api_base_url: string;
  display_name: string;
  git_base_url: string;
  provider_id: string;
  token: string;
  token_ref: string;
  web_base_url: string;
};

export type RemoteGitConnectorStatus = {
  api_base_url: string;
  auth_ref: string;
  git_base_url: string;
  provider_id: string;
  secrets: { token: { configured: boolean } };
  status: "configured" | "disabled" | "misconfigured";
  web_base_url: string;
};

type RemoteGitMutationReceipt = {
  fingerprint: string;
  response: RemoteGitMutationResponse<unknown>;
};

interface RemoteGitMutationReceiptStore {
  get(key: string): Promise<RemoteGitMutationReceipt | null>;
  put(key: string, receipt: RemoteGitMutationReceipt): Promise<void>;
}

function createMemoryRemoteGitMutationReceiptStore(): RemoteGitMutationReceiptStore {
  const receipts = new Map<string, RemoteGitMutationReceipt>();
  return {
    async get(key) {
      return receipts.get(key) ?? null;
    },
    async put(key, receipt) {
      receipts.set(key, receipt);
    }
  };
}

export function buildRemoteGitConnectorConfig(input: {
  api_base_url: unknown;
  default_api_base_url: string;
  default_git_base_url: string;
  default_token_ref: string;
  default_web_base_url: string;
  display_name: string;
  git_base_url: unknown;
  provider_id: string;
  token: unknown;
  token_ref: unknown;
  web_base_url: unknown;
}): RemoteGitConnectorConfig {
  const tokenRef = cleanText(input.token_ref) || input.default_token_ref;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(tokenRef)) {
    throw new Error("remote Git token ref must be a secret locator, not a raw credential");
  }
  return {
    api_base_url: cleanBaseUrl(input.api_base_url, input.default_api_base_url, "API base URL"),
    display_name: requiredText(input.display_name, "provider display name", 128),
    git_base_url: cleanBaseUrl(input.git_base_url, input.default_git_base_url, "Git base URL", true),
    provider_id: requiredText(input.provider_id, "provider id", 128),
    token: cleanText(input.token),
    token_ref: tokenRef,
    web_base_url: cleanBaseUrl(input.web_base_url, input.default_web_base_url, "web base URL")
  };
}

export function remoteGitConnectorStatus(config: RemoteGitConnectorConfig): RemoteGitConnectorStatus {
  const tokenConfigured = config.token !== "";
  const refConfigured = config.token_ref !== "";
  return {
    api_base_url: config.api_base_url,
    auth_ref: config.token_ref,
    git_base_url: config.git_base_url,
    provider_id: config.provider_id,
    secrets: { token: { configured: tokenConfigured } },
    status: tokenConfigured && refConfigured ? "configured" : tokenConfigured ? "misconfigured" : "disabled",
    web_base_url: config.web_base_url
  };
}

export function redactRemoteGitConnectorConfig(config: RemoteGitConnectorConfig): RemoteGitConnectorConfig {
  return { ...config, token: config.token === "" ? "" : "[redacted]" };
}

export class RemoteGitMutationCoordinator {
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<RemoteGitMutationResponse<unknown>> }>();

  constructor(private readonly receipts: RemoteGitMutationReceiptStore = createMemoryRemoteGitMutationReceiptStore()) {}

  async execute<T>(input: {
    fingerprint: string;
    idempotency_key: string;
    operation: Exclude<RemoteGitOperation, "read_pull_request">;
    perform: () => Promise<RemoteGitMutationResponse<T>>;
    provider_id: string;
    repository_ref: string;
  }): Promise<RemoteGitMutationResponse<T>> {
    const key = mutationReceiptKey(input);
    const receipt = await this.receipts.get(key);
    if (receipt) return replayReceipt<T>(receipt, input.fingerprint, input);

    const pending = this.inFlight.get(key);
    if (pending) {
      if (pending.fingerprint !== input.fingerprint) throw idempotencyConflict(input);
      const response = await pending.promise;
      return { ...response, idempotency: { key: input.idempotency_key, replayed: true } } as RemoteGitMutationResponse<T>;
    }

    const promise = (async () => {
      const response = await input.perform();
      await this.receipts.put(key, { fingerprint: input.fingerprint, response });
      return response as RemoteGitMutationResponse<unknown>;
    })();
    this.inFlight.set(key, { fingerprint: input.fingerprint, promise });
    try {
      return await promise as RemoteGitMutationResponse<T>;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function canonicalFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim() ?? "";
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(1, Math.ceil(Number(value)));
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - now) / 1000));
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mutationReceiptKey(input: {
  idempotency_key: string;
  operation: Exclude<RemoteGitOperation, "read_pull_request">;
  provider_id: string;
  repository_ref: string;
}): string {
  return canonicalFingerprint(input);
}

function replayReceipt<T>(
  receipt: RemoteGitMutationReceipt,
  fingerprint: string,
  input: {
    idempotency_key: string;
    operation: Exclude<RemoteGitOperation, "read_pull_request">;
    provider_id: string;
  }
): RemoteGitMutationResponse<T> {
  if (receipt.fingerprint !== fingerprint) throw idempotencyConflict(input);
  return {
    ...receipt.response,
    idempotency: { key: input.idempotency_key, replayed: true }
  } as RemoteGitMutationResponse<T>;
}

function idempotencyConflict(input: {
  idempotency_key: string;
  operation: Exclude<RemoteGitOperation, "read_pull_request">;
  provider_id: string;
}): RemoteGitIdempotencyConflictError {
  return new RemoteGitIdempotencyConflictError("remote Git idempotency key is already bound to another mutation", {
    idempotency_key: input.idempotency_key,
    operation: input.operation,
    provider_id: input.provider_id
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function cleanBaseUrl(value: unknown, fallback: string, label: string, allowFile = false): string {
  const text = cleanText(value) || fallback;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!(["https:", "http:"].includes(parsed.protocol) || (allowFile && parsed.protocol === "file:"))) {
    throw new Error(`${label} must use ${allowFile ? "http, https, or file" : "http or https"}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${label} cannot contain credentials, query, or fragment`);
  return parsed.toString().replace(/\/+$/, "");
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = cleanText(value);
  if (text === "") throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (/\0|\r|\n/.test(text)) throw new Error(`${label} cannot contain control lines`);
  return text;
}
