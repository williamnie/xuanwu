import { selectedCredentialSource, type CredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import { codexLoginFailureCode } from "../../pi/runtime/codexLoginCredentials.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent, getPiSupervisor } from "../../db/repositories/pi.ts";
import { HttpError } from "../errors.ts";
import { discoverPiOpenAICodexModels, isPiOpenAICodexOAuthConfigured, removePiOpenAICodexOAuthCredential } from "./piOAuthApi.ts";
import { registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import { SecretStoreError } from "../../security/secrets/contracts.ts";
import { type SecretService } from "../../security/secrets/service.ts";
import { cleanString, isRecord } from "../../util/values.ts";
import type { PiProviderSettingsContext, ProviderConnectionResult, ProviderConfig, ProviderPreset } from "./piProviderSettingsApi.model.ts";
import { modelsPath, readModelsConfig } from "./piProviderSettingsApi.normalizeModelsConfig.ts";
import { writeModelsConfig, providerSecretName } from "./piProviderSettingsApi.upsertProviderSettings.ts";

export async function deleteProviderSettings(context: PiProviderSettingsContext, id: string) {
  const supervisor = getPiSupervisor(context.database);
  if (supervisor?.model_provider === id) {
    throw new HttpError(409, "当前 Supervisor 正在使用此连接，请先切换并保存其他连接");
  }
  const path = modelsPath(context.database);
  const config = await readModelsConfig(path);
  const current = config.providers[id];
  const configured = current !== undefined;
  if (configured) {
    delete config.providers[id];
    await writeModelsConfig(path, config);
  }
  const secretRef = cleanString(current?.apiKeyRef) || `secret://${providerSecretName(id).split("/").map(encodeURIComponent).join("/")}`;
  const secret = context.secrets!.describe(secretRef);
  const credentialRevoked = secret?.status === "active";
  if (credentialRevoked) {
    context.secrets!.revoke(secretRef, "user", `deleted provider connection ${id}`);
  }
  const oauthDisconnected = id === "openai-codex"
    ? await removePiOpenAICodexOAuthCredential(context.database)
    : false;
  recordProviderSettingsDeletedAudit(context.database, id, {
    configured,
    credentialRevoked,
    oauthDisconnected
  });
  return {
    credential_revoked: credentialRevoked,
    deleted: configured || credentialRevoked || oauthDisconnected,
    oauth_disconnected: oauthDisconnected,
    provider_id: id
  };
}

export async function oauthModelDiscoveryResult(context: PiProviderSettingsContext, id: string, source?: CredentialSource): Promise<ProviderConnectionResult> {
  const configured = id === "openai-codex" && await isPiOpenAICodexOAuthConfigured(context.database, source);
  const failure = (error: string, message: string): ProviderConnectionResult => ({
    auth: "oauth",
    checked_at: new Date().toISOString(),
    error,
    message,
    models: [],
    ok: false,
    provider_id: id,
    status: "failed"
  });
  if (!configured) return selectedCredentialSource(context.database, source) === "codex_login"
    ? failure("codex_login_missing", "未找到可复用的 Codex 登录，请先在 Codex 中登录")
    : failure("oauth_not_configured", "请先完成 Codex OAuth 登录");
  try {
    const discover = context.piOpenAICodexModelDiscovery ?? discoverPiOpenAICodexModels;
    const models = modelIDsFromPayload(await discover(context.database, undefined, source));
    if (models.length === 0) return failure("model_list_empty", "Codex model API 未返回可用模型");
    return {
      auth: "oauth",
      checked_at: new Date().toISOString(),
      message: `连接成功，发现 ${models.length} 个模型`,
      models,
      ok: true,
      provider_id: id,
      status: "connected"
    };
  } catch (error) {
    if (selectedCredentialSource(context.database, source) === "codex_login") {
      return failure(codexLoginFailureCode(error), "Codex 登录暂不可用，请在 Codex 中重新登录或稍后重试");
    }
    return failure("model_api_failed", "Codex model API 请求失败");
  }
}

export async function probeApiKeyProvider(
  id: string,
  body: Record<string, unknown>,
  current: ProviderConfig,
  preset: ProviderPreset | undefined,
  secrets: SecretService
): Promise<ProviderConnectionResult> {
  const api = cleanString(body.api) || current.api || preset?.api || "";
  const submittedKey = cleanString(body.api_key) || cleanString(body.apiKey);
  if (submittedKey !== "") registerSecretForRedaction(submittedKey);
  const baseUrl = cleanString(body.base_url) || cleanString(body.baseUrl) || current.baseUrl || preset?.base_url || "";
  const failure = (error: string, message: string, httpStatus?: number): ProviderConnectionResult => ({
    auth: "api_key",
    checked_at: new Date().toISOString(),
    error,
    ...(httpStatus ? { http_status: httpStatus } : {}),
    message,
    models: [],
    ok: false,
    provider_id: id,
    status: "failed"
  });
  let apiKey = submittedKey || cleanString(current.apiKey);
  if (apiKey === "" && cleanString(current.apiKeyRef) !== "") {
    try {
      apiKey = secrets.resolve(current.apiKeyRef!);
    } catch (error) {
      if (error instanceof SecretStoreError) return failure(error.code, error.message);
      throw error;
    }
  }
  if (!apiKey) return failure("api_key_required", "请先输入或保存 API key");
  let url: URL;
  try {
    url = providerModelsURL(baseUrl);
  } catch (error) {
    return failure("invalid_base_url", error instanceof Error ? error.message : "Base URL 无效");
  }
  try {
    const response = await fetch(url, {
      headers: providerDiscoveryHeaders(api, apiKey),
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return failure("provider_http_error", `Provider returned HTTP ${response.status}`, response.status);
    }
    const models = await discoveredModelIDs(response);
    if (models.length === 0) return failure("model_list_empty", "Provider model API 未返回可用模型", response.status);
    return {
      auth: "api_key",
      checked_at: new Date().toISOString(),
      http_status: response.status,
      message: models.length > 0 ? `连接成功，发现 ${models.length} 个模型` : "连接成功",
      models,
      ok: true,
      provider_id: id,
      status: "connected"
    };
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return failure(timeout ? "provider_timeout" : "provider_unreachable", timeout ? "Provider connection timed out" : "Provider connection failed");
  }
}

export function providerModelsURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 仅支持 http/https");
  if (url.username || url.password) throw new Error("Base URL 不能包含凭据");
  if (url.search || url.hash) throw new Error("Base URL 不能包含 query 或 fragment");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  return url;
}

export function providerDiscoveryHeaders(api: string, apiKey: string): Record<string, string> {
  if (api === "anthropic") {
    return { Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
  }
  if (api === "google") return { Accept: "application/json", "x-goog-api-key": apiKey };
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

export async function discoveredModelIDs(response: Response): Promise<string[]> {
  const raw = await response.json().catch(() => null);
  return modelIDsFromPayload(raw);
}

export function modelIDsFromPayload(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : isRecord(raw) && Array.isArray(raw.models)
        ? raw.models
        : [];
  return [...new Set(values.map((item) => discoveredModelID(item)).filter(Boolean))].slice(0, 200);
}

export function discoveredModelID(value: unknown): string {
  const raw = isRecord(value) ? cleanString(value.id) || cleanString(value.name) : cleanString(value);
  const id = raw.replace(/^models\//, "");
  return id.length <= 256 ? id : "";
}

export function recordProviderSettingsDeletedAudit(
  database: RunnerDatabase,
  providerID: string,
  result: { configured: boolean; credentialRevoked: boolean; oauthDisconnected: boolean }
): void {
  createPiActionEvent(database, {
    action_id: `provider-settings-delete:${providerID}:${crypto.randomUUID()}`,
    actor: "user",
    event_type: "provider_settings_deleted",
    payload_json: JSON.stringify({ provider_id: providerID, source: "settings_http" }),
    reason: `deleted provider settings for ${providerID}`,
    result_json: JSON.stringify({
      credential_status: result.credentialRevoked ? "revoked" : "unchanged",
      oauth_disconnected: result.oauthDisconnected,
      provider_configured: result.configured,
      status: "succeeded"
    })
  });
}
