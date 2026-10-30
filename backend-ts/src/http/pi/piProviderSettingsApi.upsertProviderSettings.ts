import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai/compat";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent, getPiSupervisor } from "../../db/repositories/pi.ts";
import { HttpError, parseJsonBody } from "../errors.ts";
import { type SecretService } from "../../security/secrets/service.ts";
import { cleanString, isRecord } from "../../util/values.ts";
import type { PiProviderSettingsContext, PublicProviderSettings, ModelsConfig, ProviderConfig, ProviderModelConfig, ProviderModelOverrideConfig } from "./piProviderSettingsApi.model.ts";
import { readModelsConfig, modelsPath, PROVIDER_PRESETS, stripUndefined, knownModel, normalizeModelOverride, normalizeModel, modelIDsFromText, providerCredentialConfigured, publicModelIDs, userAgentFromHeaders } from "./piProviderSettingsApi.normalizeModelsConfig.ts";

export async function listProviderSettings(context: PiProviderSettingsContext) {
  const config = await readModelsConfig(modelsPath(context.database));
  const activeProviderID = getPiSupervisor(context.database)?.model_provider ?? "";
  return { providers: Object.entries(config.providers).map((entry) => publicProviderSettings(entry, context.secrets, activeProviderID)) };
}

export async function upsertProviderSettings(
  context: PiProviderSettingsContext,
  id: string,
  body: Record<string, unknown>
): Promise<PublicProviderSettings> {
  const path = modelsPath(context.database);
  const config = await readModelsConfig(path);
  const current = config.providers[id] ?? {};
  if ((cleanString(body.api) || current.api || "") === "") throw new HttpError(400, "api is required");
  const submittedKey = cleanString(body.api_key) || cleanString(body.apiKey);
  const keyRef = submittedKey === ""
    ? cleanString(current.apiKeyRef)
    : context.secrets!.putOrRotate(providerSecretName(id), submittedKey, "user", `updated provider credential for ${id}`).ref;
  const next = normalizeProviderConfig(id, body, current, keyRef, submittedKey !== "");
  config.providers[id] = next;
  await writeModelsConfig(path, config);
  const publicSettings = publicProviderSettings(
    [id, next],
    context.secrets,
    getPiSupervisor(context.database)?.model_provider ?? ""
  );
  recordProviderSettingsAudit(context.database, id, body, publicSettings);
  return publicSettings;
}

export function providerCatalog() {
  return {
    presets: PROVIDER_PRESETS.map((preset) => ({
      ...preset,
      models: builtinModelCatalog(preset.id)
    }))
  };
}

export async function writeModelsConfig(path: string, config: ModelsConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function normalizeProviderConfig(
  id: string,
  body: Record<string, unknown>,
  current: ProviderConfig,
  apiKeyRef: string,
  credentialChanged: boolean
): ProviderConfig {
  const api = cleanString(body.api) || current.api || "";
  if (api === "") throw new HttpError(400, "api is required");
  const selection = hasOwn(body, "models")
    ? normalizeModelSelection(body.models, id)
    : { models: current.models ?? [], modelOverrides: current.modelOverrides ?? {} };
  return stripUndefined({
    ...current,
    api,
    apiKey: credentialChanged ? undefined : cleanString(current.apiKey) || undefined,
    apiKeyRef: apiKeyRef || undefined,
    baseUrl: cleanString(body.base_url) || cleanString(body.baseUrl) || cleanString(current.baseUrl) || undefined,
    headers: nextHeaders(current.headers, body),
    models: selection.models,
    modelOverrides: selection.modelOverrides
  });
}

export function normalizeModelSelection(
  value: unknown,
  providerID: string
): { models: ProviderModelConfig[]; modelOverrides: Record<string, ProviderModelOverrideConfig> } {
  const models: ProviderModelConfig[] = [];
  const modelOverrides: Record<string, ProviderModelOverrideConfig> = {};
  for (const item of modelItems(value)) {
    const id = cleanString(isRecord(item) ? item.id : item);
    if (!id) continue;
    if (knownModel(providerID, id)) modelOverrides[id] = normalizeModelOverride(item);
    else models.push(normalizeModel(providerID, item) ?? { id });
  }
  return { models, modelOverrides };
}

export function modelItems(value: unknown): unknown[] {
  if (typeof value === "string") return modelIDsFromText(value);
  return Array.isArray(value) ? value : [];
}

export function publicProviderSettings(
  [id, provider]: [string, ProviderConfig],
  secrets?: SecretService,
  activeProviderID = ""
): PublicProviderSettings {
  return {
    id,
    api: provider.api ?? "",
    api_key_configured: providerCredentialConfigured(provider, secrets),
    base_url: provider.baseUrl ?? "",
    in_use: activeProviderID === id,
    models: publicModelIDs(provider),
    user_agent: userAgentFromHeaders(provider.headers)
  };
}

export function providerSecretName(providerID: string): string {
  return `pi/provider/${encodeURIComponent(providerID)}/api-key`;
}

export function nextHeaders(current: Record<string, string> | undefined, body: Record<string, unknown>): Record<string, string> | undefined {
  const headers = { ...(current ?? {}) };
  if (!hasOwn(body, "user_agent") && !hasOwn(body, "userAgent")) return emptyAsUndefined(headers);
  const userAgent = cleanString(body.user_agent) || cleanString(body.userAgent);
  if (userAgent === "") delete headers["User-Agent"];
  else headers["User-Agent"] = userAgent;
  return emptyAsUndefined(headers);
}

export function emptyAsUndefined(value: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

export async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return isRecord(body) ? body : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

export function providerID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = decodeURIComponent(parts[parts.indexOf("provider-settings") + 1] ?? "").trim();
  if (value === "") throw new HttpError(400, "provider id 不能为空");
  return value;
}

export function builtinModelCatalog(providerID: string) {
  if (!getProviders().includes(providerID as KnownProvider)) return [];
  return getModels(providerID as KnownProvider).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning
  }));
}

export function recordProviderSettingsAudit(
  database: RunnerDatabase,
  providerID: string,
  body: Record<string, unknown>,
  settings: PublicProviderSettings
): void {
  createPiActionEvent(database, {
    action_id: `provider-settings:${providerID}:${crypto.randomUUID()}`,
    actor: "user",
    event_type: "provider_settings_updated",
    payload_json: JSON.stringify({
      api: settings.api,
      credential_changed: cleanString(body.api_key) !== "" || cleanString(body.apiKey) !== "",
      base_url: auditBaseUrl(settings.base_url),
      models: settings.models,
      provider_id: providerID,
      source: "settings_http"
    }),
    reason: `updated provider settings for ${providerID}`,
    result_json: JSON.stringify({ credential_configured: settings.api_key_configured, status: "succeeded" })
  });
}

export function auditBaseUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
