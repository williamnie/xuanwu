import type { RunnerDatabase } from "../db/database.ts";
import { type ConnectorCapability } from "./channelConnectorContracts.ts";
import { createDatabaseSecretService } from "../security/secrets/service.ts";
import type { FeishuReceiverStatus } from "./feishu/feishuReceiver.ts";
import type { ConnectorDiagnosticsContext, StaticConnectorDefinition, ConnectorDiagnosticState, ConnectorProbeResult, ConnectorFetch } from "./connectorDiagnostics.model.ts";
import { staticDefinitions, CONNECTOR_DIAGNOSTIC_SCHEMA, connectorTestHistory, latestOutboundState } from "./connectorDiagnostics.staticDefinitions.ts";

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

export function publicDiagnostic(
  context: ConnectorDiagnosticsContext,
  definition: StaticConnectorDefinition,
  now: Date
): Record<string, unknown> {
  const history = connectorTestHistory(context.database, definition.manifest.id, now);
  const operation = latestOutboundState(context.database, definition.manifest.id, definition.source, now);
  const revoked = definition.secret_refs.some((item) => item.required === true && item.status === "revoked");
  const staticState = revoked ? "revoked" : definition.configured && operation.error
    ? operation.rate_limit ? "rate_limited" : "failed"
    : healthState(definition.configured, history.test);
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

export function receiverHealthState(
  fallback: ConnectorDiagnosticState,
  receiver: FeishuReceiverStatus | undefined
): ConnectorDiagnosticState {
  if (!receiver || receiver.receive_mode !== "websocket" || receiver.state === "disabled") return fallback;
  if (receiver.connected && receiver.state === "connected") return "healthy";
  if (receiver.state === "failed") return "failed";
  if (receiver.state === "reconnecting") return "disconnected";
  return "degraded";
}

export function permission(capability: ConnectorCapability): Record<string, unknown> {
  return {
    capability_id: capability.id,
    direction: capability.kind,
    authorization: capability.requires_authorization ? "required" : "not_required"
  };
}

export function healthState(configured: boolean, latest: ConnectorProbeResult | null): ConnectorDiagnosticState {
  if (!configured) return "unconfigured";
  return latest?.state ?? "unknown";
}

export function legacyStatus(state: ConnectorDiagnosticState, configured: boolean): string {
  if (state === "healthy") return "configured";
  if (configured && (state === "degraded" || state === "unknown")) return "configured";
  if (state === "unconfigured") return configured ? "misconfigured" : "disabled";
  if (state === "revoked") return "misconfigured";
  return "error";
}

export function lastSync(database: RunnerDatabase, connectorID: string, source: string): string {
  if (connectorID.endsWith("-issues")) {
    return database.sqlite.query<{ created_at: string }, [string]>(
      "select created_at from tracker_sync_events where provider=? order by id desc limit 1"
    ).get(source)?.created_at ?? "";
  }
  return database.sqlite.query<{ received_at: string }, [string, string]>(
    "select received_at from external_events where source=? or provider=? order by received_at desc, id desc limit 1"
  ).get(source, source)?.received_at ?? "";
}

export async function probeHttp(
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

export function success(checkedAt: string, httpStatus?: number): ConnectorProbeResult {
  return { checked_at: checkedAt, ...(httpStatus ? { http_status: httpStatus } : {}), ok: true, state: "healthy" };
}

export function failure(
  checkedAt: string,
  code: string,
  message: string,
  state: ConnectorDiagnosticState,
  httpStatus?: number
): ConnectorProbeResult {
  return { checked_at: checkedAt, error: { code, message }, ...(httpStatus ? { http_status: httpStatus } : {}), ok: false, state };
}

export function positiveSeconds(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(86_400, Math.ceil(parsed)) : 0;
}

export function rateLimitSeconds(headers: Headers, now: Date): number {
  const retryAfter = positiveSeconds(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter;
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(resetSeconds) ? Math.max(1, Math.ceil(resetSeconds - now.getTime() / 1000)) : 0;
}

export function latestTimestamp(...values: string[]): string {
  return values.filter((value) => value !== "").sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "";
}
