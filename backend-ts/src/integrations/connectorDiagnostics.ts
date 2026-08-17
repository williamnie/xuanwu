import type { RunnerConfig } from "../config/env.ts";
import { readLocalSettingsSync } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { githubConnectorStatus } from "./github/config.ts";
import { gitlabConnectorStatus } from "./gitlab/config.ts";
import { feishuConnectorStatus } from "./feishu.ts";
import { gitEventConnectorManifest } from "./gitEvents.ts";
import { trackerIssueConnectorManifest } from "./tracker/issueSync.ts";
import { WEBHOOK_CHANNEL_MANIFEST } from "../http/webhookEventsApi.ts";
import {
  type ConnectorCapability,
  type ConnectorManifest
} from "./channelConnectorContracts.ts";
import { feishuChannelConnectorManifest } from "./feishuChannelConnector.ts";
import { telegramChannelConnectorManifest } from "./telegramChannelConnector.ts";
import { createTelegramBotClient, TelegramClientError } from "./telegramClient.ts";
import { telegramConnectorStatus } from "./telegramConfig.ts";
import { createDatabaseSecretService, type SecretService } from "../security/secrets/service.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuReceiverStatus } from "./feishuReceiver.ts";

export const CONNECTOR_DIAGNOSTIC_SCHEMA = "xuanwu.connector-diagnostics.v1" as const;

export type ConnectorDiagnosticState =
  | "unconfigured"
  | "healthy"
  | "degraded"
  | "rate_limited"
  | "disconnected"
  | "failed"
  | "revoked";

export type ConnectorProbeResult = {
  checked_at: string;
  error?: { code: string; message: string };
  http_status?: number;
  ok: boolean;
  rate_limit?: { retry_after_seconds: number; reset_at: string };
  state: ConnectorDiagnosticState;
};

type ConnectorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ConnectorDiagnosticsContext = {
  config: RunnerConfig;
  database: RunnerDatabase;
  feishuReceiverStatus?: FeishuReceiverStatus;
  now?: () => Date;
  secrets?: SecretService;
  webhookSigningSecret?: string;
};

type StaticConnectorDefinition = {
  configured: boolean;
  manifest: ConnectorManifest;
  missing_required: string[];
  secret_refs: Array<Record<string, unknown>>;
  source: string;
  source_of_truth: string;
  test_supported: boolean;
};

export function buildStaticConnectorDiagnostics(context: ConnectorDiagnosticsContext): Array<Record<string, unknown>> {
  const now = context.now?.() ?? new Date();
  const secrets = context.secrets ?? createDatabaseSecretService(context.database);
  return staticDefinitions(context, secrets).map((definition) => publicDiagnostic(context, definition, now));
}

export function buildConnectorDiagnosticBundle(
  context: ConnectorDiagnosticsContext,
  cliConnectors: Array<Record<string, unknown>> = [],
  cliDiagnostics: unknown[] = []
): Record<string, unknown> {
  const generatedAt = (context.now?.() ?? new Date()).toISOString();
  return {
    schema_version: CONNECTOR_DIAGNOSTIC_SCHEMA,
    generated_at: generatedAt,
    redaction: { secret_values: true, provider_error_bodies: true },
    source_of_truth: {
      health: "live config plus existing external_events, tracker_sync_events, sync_outbox and connector test audit",
      secrets: "SecretService metadata; material is never read back",
      writes: "existing provider adapters and sync_outbox remain authoritative"
    },
    connectors: [...buildStaticConnectorDiagnostics(context), ...cliConnectors],
    diagnostics: cliDiagnostics
  };
}

export async function probeConnectorConnection(input: {
  config: RunnerConfig;
  connectorID: string;
  fetch?: ConnectorFetch;
  now?: () => Date;
  webhookSigningSecret?: string;
}): Promise<ConnectorProbeResult> {
  const now = input.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const id = input.connectorID.trim();
  if (id === "webhook") {
    return clean(input.webhookSigningSecret) === ""
      ? failure(checkedAt, "not_configured", "Webhook signing secret is not configured", "unconfigured")
      : success(checkedAt);
  }
  if (id === "feishu") return probeFeishu(input, checkedAt);
  if (id === "telegram") return probeTelegram(input, checkedAt);
  if (id === "github-events" || id === "github-issues") {
    const config = input.config.integrations.github;
    if (config.token === "") return failure(checkedAt, "not_configured", "GitHub credential is not configured", "unconfigured");
    return probeHttp(input.fetch ?? fetch, `${config.api_base_url}/user`, {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.token}`,
      "user-agent": "xuanwu-connector-health/1"
    }, checkedAt, now);
  }
  if (id === "gitlab-events" || id === "gitlab-issues") {
    const config = input.config.integrations.gitlab;
    if (config.token === "") return failure(checkedAt, "not_configured", "GitLab credential is not configured", "unconfigured");
    return probeHttp(input.fetch ?? fetch, `${config.api_base_url}/user`, {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
      "user-agent": "xuanwu-connector-health/1"
    }, checkedAt, now);
  }
  if (id === "linear-issues") {
    return failure(checkedAt, "not_configured", "Linear tracker adapter is not configured", "unconfigured");
  }
  return failure(checkedAt, "connector_not_found", "Connector is not registered", "failed");
}

export function connectorTestHistory(
  database: RunnerDatabase,
  connectorID: string,
  now = new Date()
): { attempts: number; blocked: boolean; retry_at: string; test: ConnectorProbeResult | null } {
  const rows = database.sqlite.query<{ payload_json: string; result_json: string }, [string]>(`
    select payload_json, result_json from pi_action_events
    where event_type='connector.tested' and json_valid(payload_json)
      and json_extract(payload_json, '$.connector_id')=?
    order by id desc limit 20
  `).all(connectorID);
  const results = rows.map((row) => probeResult(row.result_json)).filter((item): item is ConnectorProbeResult => item !== null);
  const attempts = consecutiveFailures(results);
  const latest = results[0] ?? null;
  if (!latest || latest.ok) return { attempts: 0, blocked: false, retry_at: "", test: latest };
  const providerSeconds = latest.rate_limit?.retry_after_seconds ?? 0;
  const backoffSeconds = Math.max(providerSeconds, Math.min(900, 30 * 2 ** Math.max(0, attempts - 1)));
  const retryAt = new Date(Date.parse(latest.checked_at) + backoffSeconds * 1000).toISOString();
  return { attempts, blocked: Date.parse(retryAt) > now.getTime(), retry_at: retryAt, test: latest };
}

function staticDefinitions(context: ConnectorDiagnosticsContext, secrets: SecretService): StaticConnectorDefinition[] {
  const local = readLocalSettingsSync(context.config.stateDir).integrations ?? {};
  const feishuStatus = feishuConnectorStatus(context.config.integrations.feishu) as { missing_required?: unknown; status?: unknown };
  const telegramStatus = telegramConnectorStatus(context.config.integrations.telegram);
  const githubStatus = githubConnectorStatus(context.config.integrations.github);
  const gitlabStatus = gitlabConnectorStatus(context.config.integrations.gitlab);
  const githubSecret = secretEntry("token", context.config.integrations.github.token_ref, context.config.integrations.github.token !== "", true, secrets);
  const gitlabSecret = secretEntry("token", context.config.integrations.gitlab.token_ref, context.config.integrations.gitlab.token !== "", true, secrets);
  const feishuRefs = [
    secretEntry("app_secret", text(local.feishu?.appSecretRef), context.config.integrations.feishu.appSecret !== "", true, secrets),
    secretEntry("verification_token", text(local.feishu?.verificationTokenRef), context.config.integrations.feishu.verificationToken !== "", context.config.integrations.feishu.receiveMode === "callback", secrets),
    secretEntry("encrypt_key", text(local.feishu?.encryptKeyRef), context.config.integrations.feishu.encryptKey !== "", false, secrets)
  ];
  const webhookConfigured = clean(context.webhookSigningSecret) !== "";
  const telegramSecret = secretEntry(
    "bot_token",
    text(local.telegram?.botTokenRef),
    context.config.integrations.telegram.botToken !== "",
    true,
    secrets
  );
  return [
    {
      configured: feishuStatus.status === "configured",
      manifest: feishuChannelConnectorManifest(feishuRefs.flatMap((item) => typeof item.ref === "string" ? [item.ref] : [])),
      missing_required: stringList(feishuStatus.missing_required),
      secret_refs: feishuRefs,
      source: "feishu",
      source_of_truth: "Feishu runtime config and external_events",
      test_supported: true
    },
    {
      configured: telegramStatus.status === "configured",
      manifest: telegramChannelConnectorManifest(typeof telegramSecret.ref === "string" ? [telegramSecret.ref] : []),
      missing_required: telegramStatus.missing_required,
      secret_refs: [telegramSecret],
      source: "telegram",
      source_of_truth: "Telegram long-poll cursor, external_events and sync_outbox",
      test_supported: true
    },
    {
      configured: webhookConfigured,
      manifest: WEBHOOK_CHANNEL_MANIFEST,
      missing_required: webhookConfigured ? [] : ["XUANWU_WEBHOOK_SIGNING_SECRET"],
      secret_refs: [secretEntry("signing_secret", "env://XUANWU_WEBHOOK_SIGNING_SECRET", webhookConfigured, true, secrets)],
      source: "webhook",
      source_of_truth: "signed webhook route and external_events",
      test_supported: true
    },
    providerDefinition(gitEventConnectorManifest("github"), githubStatus.status === "configured", githubSecret, "external_events"),
    providerDefinition(gitEventConnectorManifest("gitlab"), gitlabStatus.status === "configured", gitlabSecret, "external_events"),
    providerDefinition(trackerIssueConnectorManifest("github"), githubStatus.status === "configured", githubSecret, "tracker sync tables and issues"),
    providerDefinition(trackerIssueConnectorManifest("gitlab"), gitlabStatus.status === "configured", gitlabSecret, "tracker sync tables and issues"),
    providerDefinition(trackerIssueConnectorManifest("linear"), false, secretEntry("token", "", false, true, secrets), "tracker sync tables and issues")
  ];
}

function providerDefinition(
  manifest: ConnectorManifest,
  configured: boolean,
  secret: Record<string, unknown>,
  sourceOfTruth: string
): StaticConnectorDefinition {
  return {
    configured,
    manifest,
    missing_required: configured ? [] : ["credential"],
    secret_refs: [secret],
    source: manifest.id.endsWith("-issues") ? manifest.id.replace(/-issues$/, "") : manifest.id.replace(/-events$/, ""),
    source_of_truth: sourceOfTruth,
    test_supported: manifest.id !== "linear-issues"
  };
}

function publicDiagnostic(
  context: ConnectorDiagnosticsContext,
  definition: StaticConnectorDefinition,
  now: Date
): Record<string, unknown> {
  const history = connectorTestHistory(context.database, definition.manifest.id, now);
  const operation = latestOutboundState(context.database, definition.manifest.id, definition.source, now);
  const revoked = definition.secret_refs.some((item) => item.required === true && item.status === "revoked");
  const staticState = revoked ? "revoked" : healthState(definition.configured, history.test);
  const receiver = definition.manifest.id === "feishu" ? context.feishuReceiverStatus : undefined;
  const state = receiverHealthState(staticState, receiver);
  const lastSyncAt = lastSync(context.database, definition.manifest.id, definition.source);
  const runtimeChecked = Boolean(receiver && receiver.receive_mode === "websocket" && receiver.state !== "disabled");
  return {
    id: definition.manifest.id,
    label: definition.manifest.display_name,
    kind: definition.manifest.kind,
    enabled: definition.configured && !revoked,
    status: legacyStatus(state, definition.configured),
    manifest: {
      contract_version: definition.manifest.contract_version,
      capabilities: definition.manifest.capabilities,
      auth_refs: definition.manifest.auth_refs
    },
    permissions: definition.manifest.capabilities.map(permission),
    secret_refs: definition.secret_refs,
    health: {
      checked: runtimeChecked || history.test !== null,
      checked_at: runtimeChecked ? now.toISOString() : history.test?.checked_at ?? "",
      state,
      last_sync_at: latestTimestamp(lastSyncAt, operation.updated_at, receiver?.last_event_at ?? ""),
      last_error: receiver?.last_error
        ? { code: "receiver_runtime_error", message: receiver.last_error }
        : history.test?.error ?? operation.error,
      rate_limit: history.test?.rate_limit ?? operation.rate_limit,
      backoff: operation.blocked
        ? { attempt: operation.attempts, blocked: true, retry_at: operation.retry_at }
        : { attempt: history.attempts, blocked: history.blocked, retry_at: history.retry_at }
    },
    ...(receiver ? { runtime: receiver } : {}),
    test_connection: { supported: definition.test_supported },
    revoke: { supported: definition.secret_refs.some((item) => item.revocable === true) },
    source_of_truth: definition.source_of_truth,
    summary: { configured: definition.configured && !revoked, state, error: history.test?.error?.message ?? "" },
    missing_required: [...new Set([
      ...definition.missing_required,
      ...definition.secret_refs.filter((item) => item.required === true && item.configured !== true).map((item) => String(item.name ?? ""))
    ].filter(Boolean))]
  };
}

function receiverHealthState(
  fallback: ConnectorDiagnosticState,
  receiver: FeishuReceiverStatus | undefined
): ConnectorDiagnosticState {
  if (!receiver || receiver.receive_mode !== "websocket" || receiver.state === "disabled") return fallback;
  if (receiver.connected && receiver.state === "connected") return "healthy";
  if (receiver.state === "failed") return "failed";
  if (receiver.state === "reconnecting") return "disconnected";
  return "degraded";
}

function secretEntry(
  name: string,
  ref: string,
  configured: boolean,
  required: boolean,
  secrets: SecretService
): Record<string, unknown> {
  let status = configured ? "active" : "missing";
  let version: number | undefined;
  if (ref.startsWith("secret://")) {
    try {
      const metadata = secrets.describe(ref);
      status = metadata?.status ?? "missing";
      version = metadata?.version;
      configured = status === "active";
    } catch {
      status = "unavailable";
      configured = false;
    }
  } else if (ref === "" && configured) {
    status = "legacy";
  }
  return {
    name,
    ref,
    configured,
    required,
    revocable: ref.startsWith("secret://") && status === "active",
    status,
    ...(version === undefined ? {} : { version })
  };
}

function permission(capability: ConnectorCapability): Record<string, unknown> {
  return {
    capability_id: capability.id,
    direction: capability.kind,
    authorization: capability.requires_authorization ? "required" : "not_required"
  };
}

function healthState(configured: boolean, latest: ConnectorProbeResult | null): ConnectorDiagnosticState {
  if (!configured) return "unconfigured";
  return latest?.state ?? "degraded";
}

function legacyStatus(state: ConnectorDiagnosticState, configured: boolean): string {
  if (state === "healthy") return "configured";
  if (configured && state === "degraded") return "configured";
  if (state === "unconfigured") return configured ? "misconfigured" : "disabled";
  if (state === "revoked") return "misconfigured";
  return "error";
}

function lastSync(database: RunnerDatabase, connectorID: string, source: string): string {
  if (connectorID.endsWith("-issues")) {
    return database.sqlite.query<{ created_at: string }, [string]>(
      "select created_at from tracker_sync_events where provider=? order by id desc limit 1"
    ).get(source)?.created_at ?? "";
  }
  return database.sqlite.query<{ received_at: string }, [string, string]>(
    "select received_at from external_events where source=? or provider=? order by received_at desc, id desc limit 1"
  ).get(source, source)?.received_at ?? "";
}

function latestOutboundState(
  database: RunnerDatabase,
  connectorID: string,
  provider: string,
  now: Date
): {
  attempts: number;
  blocked: boolean;
  error: { code: string; message: string } | null;
  rate_limit: { retry_after_seconds: number; reset_at: string } | null;
  retry_at: string;
  updated_at: string;
} {
  const empty = { attempts: 0, blocked: false, error: null, rate_limit: null, retry_at: "", updated_at: "" };
  if (!connectorID.endsWith("-issues")) return empty;
  const row = database.sqlite.query<{
    attempt_count: number; cooldown_until: string; last_error: string; retry_after_seconds: number;
    status: string; updated_at: string;
  }, [string]>(`select attempt_count, cooldown_until, last_error, retry_after_seconds, status, updated_at
    from sync_outbox where operation_kind='tracker_update'
      and json_extract(payload_json, '$.target.provider_id')=?
    order by updated_at desc, id desc limit 1`).get(provider);
  if (!row) return empty;
  const retryAt = text(row.cooldown_until);
  const retrySeconds = Number.isInteger(row.retry_after_seconds) && row.retry_after_seconds > 0
    ? row.retry_after_seconds
    : 0;
  const failed = ["failed", "retry"].includes(text(row.status)) && text(row.last_error) !== "";
  return {
    attempts: Number.isInteger(row.attempt_count) ? row.attempt_count : 0,
    blocked: retryAt !== "" && Date.parse(retryAt) > now.getTime(),
    error: failed ? { code: "delivery_failed", message: redactSensitiveText(row.last_error) } : null,
    rate_limit: retrySeconds > 0
      ? { retry_after_seconds: retrySeconds, reset_at: retryAt || new Date(now.getTime() + retrySeconds * 1000).toISOString() }
      : null,
    retry_at: retryAt,
    updated_at: text(row.updated_at)
  };
}

async function probeFeishu(
  input: Parameters<typeof probeConnectorConnection>[0],
  checkedAt: string
): Promise<ConnectorProbeResult> {
  const config = input.config.integrations.feishu;
  if (config.appId === "" || config.appSecret === "") {
    return failure(checkedAt, "not_configured", "Feishu app credentials are not configured", "unconfigured");
  }
  return probeHttp(input.fetch ?? fetch, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    "content-type": "application/json"
  }, checkedAt, input.now?.() ?? new Date(), JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), async (response) => {
    try {
      const body = await response.json() as { code?: unknown; tenant_access_token?: unknown };
      return body.code === 0 && typeof body.tenant_access_token === "string" && body.tenant_access_token !== "";
    } catch {
      return false;
    }
  });
}

async function probeTelegram(
  input: Parameters<typeof probeConnectorConnection>[0],
  checkedAt: string
): Promise<ConnectorProbeResult> {
  const config = input.config.integrations.telegram;
  if (config.botToken === "") return failure(checkedAt, "not_configured", "Telegram bot token is not configured", "unconfigured");
  try {
    await createTelegramBotClient({ config, fetch: input.fetch }).getMe();
    return success(checkedAt);
  } catch (error) {
    if (!(error instanceof TelegramClientError)) {
      return failure(checkedAt, "network_unreachable", "Connector endpoint is unreachable", "disconnected");
    }
    if (error.kind === "rate_limited") {
      const seconds = error.retryAfterSeconds ?? 60;
      const now = input.now?.() ?? new Date();
      return {
        ...failure(checkedAt, "rate_limited", "Connector rate limit was reached", "rate_limited", error.status),
        rate_limit: { retry_after_seconds: seconds, reset_at: new Date(now.getTime() + seconds * 1000).toISOString() }
      };
    }
    if (error.kind === "auth") {
      return failure(checkedAt, "credential_expired", "Connector credential was rejected", "degraded", error.status);
    }
    if (error.kind === "transient") {
      return failure(checkedAt, "network_unreachable", "Connector endpoint is unreachable", "disconnected", error.status);
    }
    return failure(checkedAt, "provider_error", "Connector test failed", "failed", error.status);
  }
}

async function probeHttp(
  fetchImpl: ConnectorFetch,
  url: string,
  headers: Record<string, string>,
  checkedAt: string,
  now: Date,
  body?: string,
  validateSuccess?: (response: Response) => Promise<boolean>
): Promise<ConnectorProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      body,
      headers,
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    return failure(checkedAt, "network_unreachable", "Connector endpoint is unreachable", "disconnected");
  }
  if (response.ok) {
    if (validateSuccess && !(await validateSuccess(response))) {
      return failure(checkedAt, "credential_expired", "Connector credential was rejected", "degraded", response.status);
    }
    return success(checkedAt, response.status);
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    const retryAfter = rateLimitSeconds(response.headers, now) || 60;
    return {
      ...failure(checkedAt, "rate_limited", "Connector rate limit was reached", "rate_limited", response.status),
      rate_limit: { retry_after_seconds: retryAfter, reset_at: new Date(now.getTime() + retryAfter * 1000).toISOString() }
    };
  }
  if (response.status === 401 || response.status === 403) {
    return failure(checkedAt, "credential_expired", "Connector credential was rejected", "degraded", response.status);
  }
  return failure(checkedAt, "provider_error", "Connector test failed", "failed", response.status);
}

function success(checkedAt: string, httpStatus?: number): ConnectorProbeResult {
  return { checked_at: checkedAt, ...(httpStatus ? { http_status: httpStatus } : {}), ok: true, state: "healthy" };
}

function failure(
  checkedAt: string,
  code: string,
  message: string,
  state: ConnectorDiagnosticState,
  httpStatus?: number
): ConnectorProbeResult {
  return { checked_at: checkedAt, error: { code, message }, ...(httpStatus ? { http_status: httpStatus } : {}), ok: false, state };
}

function probeResult(value: string): ConnectorProbeResult | null {
  try {
    const result = JSON.parse(value) as ConnectorProbeResult;
    return typeof result?.checked_at === "string" && typeof result?.ok === "boolean" ? result : null;
  } catch {
    return null;
  }
}

function consecutiveFailures(results: ConnectorProbeResult[]): number {
  let count = 0;
  for (const result of results) {
    if (result.ok) break;
    count += 1;
  }
  return count;
}

function positiveSeconds(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(86_400, Math.ceil(parsed)) : 0;
}

function rateLimitSeconds(headers: Headers, now: Date): number {
  const retryAfter = positiveSeconds(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter;
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(resetSeconds) ? Math.max(1, Math.ceil(resetSeconds - now.getTime() / 1000)) : 0;
}

function latestTimestamp(...values: string[]): string {
  return values.filter((value) => value !== "").sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function clean(value: unknown): string {
  return text(value);
}
