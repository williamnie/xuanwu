import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { redactSensitiveText, redactedUserVisibleText } from "../../util/redact.ts";
import {
  RemoteGitIdempotencyConflictError,
  RemoteGitProviderError,
  RemoteGitRateLimitError,
  assertRemoteGitAuthRef,
  assertRemoteGitWriteContext,
  type RemoteGitAuthRef,
  type RemoteGitMutationResponse,
  type RemoteGitOperation,
  type RemoteGitProviderErrorKind,
  type RemoteGitProviderResponse,
  type RemoteGitRateLimit,
  type RemoteGitRepositoryRef,
  type RemoteGitWriteContext
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

export type RemoteGitAdapterAuditEvent = {
  actor: RemoteGitWriteContext["actor"];
  correlation_id: string;
  event_type: "handoff.remote_git.attempt.v1" | "handoff.remote_git.outcome.v1";
  facts: {
    error_kind?: RemoteGitProviderErrorKind;
    idempotency_replayed?: boolean;
    intent_event_ref: string;
    operation: Exclude<RemoteGitOperation, "read_pull_request">;
    outcome: "attempted" | "failed" | "succeeded";
    provider_request_ref?: string;
    rate_limit?: RemoteGitRateLimit;
    repository_ref: string;
    retryable?: boolean;
    target_ref: string;
  };
  handoff_id: RemoteGitWriteContext["handoff_id"];
  provider_id: string;
  work_id: RemoteGitWriteContext["work_id"];
};

export interface RemoteGitAdapterAuditSink {
  record(event: RemoteGitAdapterAuditEvent): Promise<void>;
}

export type RemoteGitMutationReceipt = {
  fingerprint: string;
  response: RemoteGitMutationResponse<unknown>;
};

export interface RemoteGitMutationReceiptStore {
  get(key: string): Promise<RemoteGitMutationReceipt | null>;
  put(key: string, receipt: RemoteGitMutationReceipt): Promise<void>;
}

export function createMemoryRemoteGitMutationReceiptStore(): RemoteGitMutationReceiptStore {
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

export type RemoteGitHttpResult = RemoteGitProviderResponse<unknown> & { status: number };

export type RemoteGitHttpClient = {
  request(input: {
    body?: unknown;
    method?: string;
    operation: RemoteGitOperation;
    path: string;
  }): Promise<RemoteGitHttpResult>;
};

export type RemoteGitHttpClientOptions = {
  auth_header: (token: string) => Record<string, string>;
  config: RemoteGitConnectorConfig;
  fetch?: FetchLike;
  rate_limit: (headers: Headers) => RemoteGitRateLimit | undefined;
  request_ref: (headers: Headers) => string | undefined;
};

export function createRemoteGitHttpClient(options: RemoteGitHttpClientOptions): RemoteGitHttpClient {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async request(input) {
      let response: Response;
      try {
        response = await fetchImpl(`${options.config.api_base_url}${input.path}`, {
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          headers: {
            accept: "application/json",
            "content-type": "application/json; charset=utf-8",
            "user-agent": "xuanwu-handoff/1",
            ...options.auth_header(options.config.token)
          },
          method: input.method ?? "GET"
        });
      } catch (error) {
        throw new RemoteGitProviderError(
          `remote Git request failed: ${safeProviderText(error, options.config.token)}`,
          { kind: "temporary", operation: input.operation, provider_id: options.config.provider_id }
        );
      }

      const providerRequestRef = options.request_ref(response.headers);
      const rateLimit = options.rate_limit(response.headers);
      const value = await responseValue(response);
      if (!response.ok) {
        throw providerHttpError({
          operation: input.operation,
          provider_id: options.config.provider_id,
          provider_request_ref: providerRequestRef,
          rate_limit: rateLimit,
          response,
          token: options.config.token,
          value
        });
      }
      return { provider_request_ref: providerRequestRef, rate_limit: rateLimit, status: response.status, value };
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

export function resolveRemoteGitToken(
  config: RemoteGitConnectorConfig,
  authRef: RemoteGitAuthRef,
  operation: RemoteGitOperation
): string {
  assertRemoteGitAuthRef(authRef, config.provider_id, operation);
  if (authRef.ref !== config.token_ref) {
    throw new RemoteGitProviderError("remote Git auth ref is not configured", {
      kind: "auth",
      operation,
      provider_id: config.provider_id
    });
  }
  if (config.token === "") {
    throw new RemoteGitProviderError("remote Git credential is not configured", {
      kind: "auth",
      operation,
      provider_id: config.provider_id
    });
  }
  return config.token;
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

export async function executeAuditedRemoteGitMutation<T>(input: {
  audit_sink: RemoteGitAdapterAuditSink;
  coordinator: RemoteGitMutationCoordinator;
  fingerprint: string;
  operation: Exclude<RemoteGitOperation, "read_pull_request">;
  perform: () => Promise<RemoteGitMutationResponse<T>>;
  provider_id: string;
  repository_ref: string;
  target_ref: string;
  write: RemoteGitWriteContext;
}): Promise<RemoteGitMutationResponse<T>> {
  assertRemoteGitWriteContext(input.write, input.operation);
  try {
    await recordAudit(input, "handoff.remote_git.attempt.v1", { outcome: "attempted" });
  } catch (error) {
    throw normalizeProviderError(error, input.operation, input.provider_id);
  }
  try {
    const response = await input.coordinator.execute({
      fingerprint: input.fingerprint,
      idempotency_key: input.write.idempotency_key,
      operation: input.operation,
      perform: input.perform,
      provider_id: input.provider_id,
      repository_ref: input.repository_ref
    });
    await recordAudit(input, "handoff.remote_git.outcome.v1", {
      idempotency_replayed: response.idempotency.replayed,
      outcome: "succeeded",
      provider_request_ref: response.provider_request_ref,
      rate_limit: response.rate_limit
    });
    return response;
  } catch (error) {
    const providerError = normalizeProviderError(error, input.operation, input.provider_id);
    await recordAudit(input, "handoff.remote_git.outcome.v1", {
      error_kind: providerError.kind,
      outcome: "failed",
      provider_request_ref: providerError.provider_request_ref,
      rate_limit: providerError.rate_limit,
      retryable: providerError.retryable
    }).catch(() => undefined);
    throw providerError;
  }
}

export function canonicalFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function idempotencyMarker(input: {
  fingerprint: string;
  idempotency_key: string;
  operation: Exclude<RemoteGitOperation, "read_pull_request">;
  provider_id: string;
  repository_ref: string;
}): { fingerprint_hash: string; key_hash: string; text: string } {
  const keyHash = canonicalFingerprint({
    idempotency_key: input.idempotency_key,
    operation: input.operation,
    provider_id: input.provider_id,
    repository_ref: input.repository_ref
  });
  return {
    fingerprint_hash: input.fingerprint,
    key_hash: keyHash,
    text: `<!-- xuanwu-handoff-idempotency key=${keyHash} fingerprint=${input.fingerprint} -->`
  };
}

export function bodyWithIdempotencyMarker(body: string, marker: string): string {
  return `${body.trim()}\n\n${marker}`.trim();
}

export function bodyWithoutIdempotencyMarker(body: unknown): string {
  return cleanText(body).replace(/\n?\n?<!-- xuanwu-handoff-idempotency key=[a-f0-9]{64} fingerprint=[a-f0-9]{64} -->/g, "").trim();
}

export function markerFingerprint(body: unknown, keyHash: string): string | null {
  const escaped = keyHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cleanText(body).match(new RegExp(
    `<!-- xuanwu-handoff-idempotency key=${escaped} fingerprint=([a-f0-9]{64}) -->`
  ));
  return match?.[1] ?? null;
}

export function preserveIdempotencyMarkers(body: string, previousBody: unknown): string {
  const markers = cleanText(previousBody).match(
    /<!-- xuanwu-handoff-idempotency key=[a-f0-9]{64} fingerprint=[a-f0-9]{64} -->/g
  ) ?? [];
  return markers.length === 0 ? body : `${body.trim()}\n\n${[...new Set(markers)].join("\n")}`;
}

export function assertRepositoryRef(
  repository: RemoteGitRepositoryRef,
  providerID: string,
  operation: RemoteGitOperation
): string {
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    throw validationError("repository must be an object", operation, providerID);
  }
  if (repository.provider_id !== providerID) {
    throw validationError("repository.provider_id does not match the provider", operation, providerID);
  }
  const ref = requiredText(repository.repository_ref, "repository.repository_ref", 1024);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(ref) || ref.split("/").some((part) => part === "." || part === "..")) {
    throw validationError("repository.repository_ref is invalid", operation, providerID);
  }
  return ref;
}

export function requiredProviderText(
  value: unknown,
  label: string,
  operation: RemoteGitOperation,
  providerID: string,
  maximum = 65_536
): string {
  try {
    return requiredText(value, label, maximum);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), operation, providerID);
  }
}

export function requiredProviderMultilineText(
  value: unknown,
  label: string,
  operation: RemoteGitOperation,
  providerID: string,
  maximum = 1_000_000
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw validationError(`${label} is required`, operation, providerID);
  if (text.length > maximum) throw validationError(`${label} exceeds ${maximum} characters`, operation, providerID);
  if (text.includes("\0")) throw validationError(`${label} cannot contain NUL`, operation, providerID);
  return text.replace(/\r\n?/g, "\n");
}

export function requiredRedactedProviderText(
  value: unknown,
  label: string,
  operation: RemoteGitOperation,
  providerID: string,
  maximum = 65_536
): string {
  const text = requiredProviderText(value, label, operation, providerID, maximum);
  return redactedUserVisibleText(text) || "[redacted]";
}

export function requiredRedactedProviderMultilineText(
  value: unknown,
  label: string,
  operation: RemoteGitOperation,
  providerID: string,
  maximum = 1_000_000
): string {
  const text = requiredProviderMultilineText(value, label, operation, providerID, maximum);
  return redactSensitiveText(text)
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]")
    .trim() || "[redacted]";
}

export function assertGitRevision(
  value: unknown,
  label: string,
  operation: RemoteGitOperation,
  providerID: string
): string {
  const revision = requiredProviderText(value, label, operation, providerID, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(revision)) {
    throw validationError(`${label} must be a Git object ID`, operation, providerID);
  }
  return revision.toLowerCase();
}

export function normalizedStringList(
  value: readonly string[] | undefined,
  label: string,
  operation: RemoteGitOperation,
  providerID: string
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw validationError(`${label} must be an array`, operation, providerID);
  const normalized = value.map((item) => requiredProviderText(item, label, operation, providerID, 256));
  if (new Set(normalized).size !== normalized.length) {
    throw validationError(`${label} must be unique`, operation, providerID);
  }
  return normalized;
}

export function assertGitBranch(value: unknown, label: string, operation: RemoteGitOperation, providerID: string): string {
  const branch = requiredProviderText(value, label, operation, providerID, 1024);
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") ||
    /\.\.|[~^:?*[\\\s]|\/\.|\.lock(?:\/|$)|@\{/.test(branch)) {
    throw validationError(`${label} is invalid`, operation, providerID);
  }
  return branch;
}

export function normalizeProviderError(error: unknown, operation: RemoteGitOperation, providerID: string): RemoteGitProviderError {
  if (error instanceof RemoteGitProviderError) return error;
  return new RemoteGitProviderError(`remote Git adapter failed: ${safeProviderText(error)}`, {
    kind: "temporary",
    operation,
    provider_id: providerID
  });
}

export type RemoteGitCli = {
  push(input: {
    authorization_header: string;
    commit_ref: string;
    expected_remote_revision: string | null;
    local_branch_ref: string;
    local_repository_path: string;
    remote_branch: string;
    remote_url: string;
  }): Promise<{ before_revision: string | null; recovered: boolean }>;
};

export function createRemoteGitCli(): RemoteGitCli {
  return {
    async push(input) {
      const repositoryPath = resolve(input.local_repository_path);
      const localRevision = await gitText(repositoryPath, [
        "rev-parse", "--verify", "--end-of-options", `${input.local_branch_ref}^{commit}`
      ]);
      if (localRevision !== input.commit_ref) throw new Error("local branch does not resolve to commit_ref");
      const targetRef = `refs/heads/${input.remote_branch}`;
      const before = await remoteRevision(repositoryPath, input.remote_url, targetRef, input.authorization_header);
      if (before === input.commit_ref && before !== input.expected_remote_revision) {
        return { before_revision: input.expected_remote_revision, recovered: true };
      }
      if (before !== input.expected_remote_revision) throw new Error("remote branch changed after preflight");
      if (before === input.commit_ref) return { before_revision: before, recovered: false };

      try {
        await gitText(repositoryPath, [
          "push", "--porcelain",
          `--force-with-lease=${targetRef}:${input.expected_remote_revision ?? ""}`,
          input.remote_url,
          `${input.commit_ref}:${targetRef}`
        ], input.authorization_header);
        return { before_revision: before, recovered: false };
      } catch (error) {
        const after = await remoteRevision(repositoryPath, input.remote_url, targetRef, input.authorization_header).catch(() => null);
        if (after === input.commit_ref) return { before_revision: before, recovered: true };
        throw error;
      }
    }
  };
}

export function remoteUrl(config: RemoteGitConnectorConfig, repositoryRef: string): string {
  return `${config.git_base_url}/${repositoryRef}.git`;
}

export function basicAuthorization(username: string, token: string): string {
  return `Authorization: Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

export function numberHeader(headers: Headers, name: string): number | undefined {
  const value = Number(headers.get(name) ?? "");
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resetAtFromEpoch(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim() ?? "";
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(1, Math.ceil(Number(value)));
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - now) / 1000));
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function cleanInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

async function recordAudit(
  input: {
    audit_sink: RemoteGitAdapterAuditSink;
    operation: Exclude<RemoteGitOperation, "read_pull_request">;
    provider_id: string;
    repository_ref: string;
    target_ref: string;
    write: RemoteGitWriteContext;
  },
  eventType: RemoteGitAdapterAuditEvent["event_type"],
  facts: Omit<RemoteGitAdapterAuditEvent["facts"], "intent_event_ref" | "operation" | "repository_ref" | "target_ref">
): Promise<void> {
  await input.audit_sink.record({
    actor: input.write.actor,
    correlation_id: input.write.correlation_id,
    event_type: eventType,
    facts: {
      intent_event_ref: input.write.intent_event_ref,
      operation: input.operation,
      repository_ref: input.repository_ref,
      target_ref: input.target_ref,
      ...facts
    },
    handoff_id: input.write.handoff_id,
    provider_id: input.provider_id,
    work_id: input.write.work_id
  });
}

async function responseValue(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) return {};
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 2048) };
  }
}

function providerHttpError(input: {
  operation: RemoteGitOperation;
  provider_id: string;
  provider_request_ref?: string;
  rate_limit?: RemoteGitRateLimit;
  response: Response;
  token: string;
  value: unknown;
}): RemoteGitProviderError {
  const message = safeProviderText(providerErrorMessage(input.value, input.response), input.token);
  const common = {
    operation: input.operation,
    provider_id: input.provider_id,
    provider_request_ref: input.provider_request_ref,
    rate_limit: input.rate_limit,
    status_code: input.response.status
  };
  if (input.response.status === 429 || (input.response.status === 403 && input.rate_limit?.remaining === 0)) {
    return new RemoteGitRateLimitError(message, { ...common, rate_limit: input.rate_limit ?? {} });
  }
  return new RemoteGitProviderError(message, { ...common, kind: httpErrorKind(input.response.status) });
}

function httpErrorKind(status: number): RemoteGitProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation";
  if (status === 408 || status >= 500) return "temporary";
  return "permanent";
}

function providerErrorMessage(value: unknown, response: Response): string {
  const body = objectValue(value);
  const message = cleanText(body.message ?? body.error ?? body.error_description);
  return `${response.status} ${message || response.statusText || "remote Git API error"}`;
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

function validationError(message: string, operation: RemoteGitOperation, providerID: string): RemoteGitProviderError {
  return new RemoteGitProviderError(message, { kind: "validation", operation, provider_id: providerID });
}

function safeProviderText(error: unknown, token = ""): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutToken = token === "" ? raw : raw.split(token).join("[redacted]");
  return redactedUserVisibleText(withoutToken) || "remote Git provider error";
}

async function remoteRevision(
  repositoryPath: string,
  remoteURL: string,
  targetRef: string,
  authorizationHeader: string
): Promise<string | null> {
  const output = await gitText(repositoryPath, ["ls-remote", "--refs", remoteURL, targetRef], authorizationHeader);
  const revision = output.split(/\s+/)[0]?.trim() ?? "";
  return /^[a-f0-9]{40,64}$/i.test(revision) ? revision : null;
}

function gitText(repositoryPath: string, args: string[], authorizationHeader = ""): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment: NodeJS.ProcessEnv = {
      GIT_CEILING_DIRECTORIES: dirname(repositoryPath),
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      HOME: repositoryPath,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: process.env.PATH ?? ""
    };
    if (authorizationHeader !== "") {
      environment.GIT_CONFIG_COUNT = "1";
      environment.GIT_CONFIG_KEY_0 = "http.extraHeader";
      environment.GIT_CONFIG_VALUE_0 = authorizationHeader;
    }
    const child = spawn("git", [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-C", repositoryPath,
      ...args
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) child.kill("SIGKILL");
      else target.push(value);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => rejectPromise(new Error(safeProviderText(error, authorizationHeader))));
    child.once("close", (code) => {
      if (bytes > 16 * 1024 * 1024) return rejectPromise(new Error("remote Git command output exceeded limit"));
      if (code !== 0) {
        const detail = safeProviderText(Buffer.concat(stderr).toString("utf8"), authorizationHeader).slice(0, 1024);
        return rejectPromise(new Error(`remote Git command failed with exit ${code}: ${detail}`));
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}
