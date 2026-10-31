import type { RunnerConfig } from "../config/env.ts";
import { createTelegramBotClient, TelegramClientError } from "./telegram/telegramClient.ts";
import type { ConnectorFetch, ConnectorProbeResult } from "./connectorDiagnostics.model.ts";
import { clean } from "./connectorDiagnostics.staticDefinitions.ts";
import { failure, success, probeHttp } from "./connectorDiagnostics.publicDiagnostic.ts";

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

export async function probeFeishu(
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

export async function probeTelegram(
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
