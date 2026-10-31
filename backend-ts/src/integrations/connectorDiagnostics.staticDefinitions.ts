import { readLocalSettingsSync } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { githubConnectorStatus } from "./github/config.ts";
import { gitlabConnectorStatus } from "./gitlab/config.ts";
import { feishuConnectorStatus } from "./feishu/feishu.ts";
import { gitEventConnectorManifest } from "./git/gitEvents.ts";
import { trackerIssueConnectorManifest } from "./tracker/issueSync.ts";
import { WEBHOOK_CHANNEL_MANIFEST } from "../http/ingress/webhookEventsApi.ts";
import { type ConnectorManifest } from "./channelConnectorContracts.ts";
import { feishuChannelConnectorManifest } from "./feishu/feishuChannelConnector.ts";
import { telegramChannelConnectorManifest } from "./telegram/telegramChannelConnector.ts";
import { telegramConnectorStatus } from "./telegram/telegramConfig.ts";
import { type SecretService } from "../security/secrets/service.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { cleanString } from "../util/values.ts";
import type { ConnectorProbeResult, ConnectorDiagnosticsContext, StaticConnectorDefinition } from "./connectorDiagnostics.model.ts";

export const CONNECTOR_DIAGNOSTIC_SCHEMA = "xuanwu.connector-diagnostics.v1" as const;

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

export function staticDefinitions(context: ConnectorDiagnosticsContext, secrets: SecretService): StaticConnectorDefinition[] {
  const local = readLocalSettingsSync(context.config.stateDir).integrations ?? {};
  const feishuStatus = feishuConnectorStatus(context.config.integrations.feishu) as { missing_required?: unknown; status?: unknown };
  const telegramStatus = telegramConnectorStatus(context.config.integrations.telegram);
  const githubStatus = githubConnectorStatus(context.config.integrations.github);
  const gitlabStatus = gitlabConnectorStatus(context.config.integrations.gitlab);
  const githubSecret = secretEntry("token", context.config.integrations.github.token_ref, context.config.integrations.github.token !== "", true, secrets);
  const gitlabSecret = secretEntry("token", context.config.integrations.gitlab.token_ref, context.config.integrations.gitlab.token !== "", true, secrets);
  const feishuRefs = [
    secretEntry("app_secret", cleanString(local.feishu?.appSecretRef), context.config.integrations.feishu.appSecret !== "", true, secrets),
    secretEntry("verification_token", cleanString(local.feishu?.verificationTokenRef), context.config.integrations.feishu.verificationToken !== "", context.config.integrations.feishu.receiveMode === "callback", secrets),
    secretEntry("encrypt_key", cleanString(local.feishu?.encryptKeyRef), context.config.integrations.feishu.encryptKey !== "", false, secrets)
  ];
  const webhookConfigured = clean(context.webhookSigningSecret) !== "";
  const telegramSecret = secretEntry(
    "bot_token",
    cleanString(local.telegram?.botTokenRef),
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

export function providerDefinition(
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

export function secretEntry(
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

export function latestOutboundState(
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
  const retryAt = cleanString(row.cooldown_until);
  const retrySeconds = Number.isInteger(row.retry_after_seconds) && row.retry_after_seconds > 0
    ? row.retry_after_seconds
    : 0;
  const failed = ["failed", "retry"].includes(cleanString(row.status)) && cleanString(row.last_error) !== "";
  return {
    attempts: Number.isInteger(row.attempt_count) ? row.attempt_count : 0,
    blocked: retryAt !== "" && Date.parse(retryAt) > now.getTime(),
    error: failed ? { code: "delivery_failed", message: redactSensitiveText(row.last_error) } : null,
    rate_limit: retrySeconds > 0
      ? { retry_after_seconds: retrySeconds, reset_at: retryAt || new Date(now.getTime() + retrySeconds * 1000).toISOString() }
      : null,
    retry_at: retryAt,
    updated_at: cleanString(row.updated_at)
  };
}

export function probeResult(value: string): ConnectorProbeResult | null {
  try {
    const result = JSON.parse(value) as ConnectorProbeResult;
    return typeof result?.checked_at === "string" && typeof result?.ok === "boolean" ? result : null;
  } catch {
    return null;
  }
}

export function consecutiveFailures(results: ConnectorProbeResult[]): number {
  let count = 0;
  for (const result of results) {
    if (result.ok) break;
    count += 1;
  }
  return count;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

export function clean(value: unknown): string {
  return cleanString(value);
}
