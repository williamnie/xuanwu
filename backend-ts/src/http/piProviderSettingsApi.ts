import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getModel, getModels, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { isPiOpenAICodexOAuthConfigured } from "./piOAuthApi.ts";
import type { Router } from "./router.ts";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import { SecretStoreError } from "../security/secrets/contracts.ts";
import { createDatabaseSecretService, type SecretService } from "../security/secrets/service.ts";

type PiProviderSettingsContext = { database: RunnerDatabase; secrets?: SecretService };
type ModelsConfig = { providers: Record<string, ProviderConfig> };
type ProviderModelConfig = {
  id: string;
  api?: string;
  baseUrl?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
};
type ProviderModelOverrideConfig = Omit<ProviderModelConfig, "id" | "api" | "baseUrl">;
type ProviderConfig = {
  api?: string;
  apiKey?: string;
  apiKeyRef?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: ProviderModelConfig[];
  modelOverrides?: Record<string, ProviderModelOverrideConfig>;
  [key: string]: unknown;
};
type PublicProviderSettings = {
  api: string;
  api_key_configured: boolean;
  base_url: string;
  id: string;
  models: string[];
  user_agent: string;
};
type ProviderAuthMode = "api_key" | "oauth";
type ProviderPreset = {
  api: string;
  auth: ProviderAuthMode;
  base_url: string;
  description: string;
  id: string;
  label: string;
  recommended: boolean;
  recommended_model: string;
};
type ProviderConnectionResult = {
  auth: ProviderAuthMode;
  checked_at: string;
  error?: string;
  http_status?: number;
  message: string;
  models: string[];
  ok: boolean;
  provider_id: string;
  status: "connected" | "failed";
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    api: "openai-responses",
    auth: "api_key",
    base_url: "https://api.openai.com/v1",
    description: "使用 OpenAI API key，默认采用稳定的 Responses API 与推荐模型。",
    id: "openai",
    label: "OpenAI",
    recommended: true,
    recommended_model: "gpt-5.4"
  },
  {
    api: "openai-codex-responses",
    auth: "oauth",
    base_url: "",
    description: "通过 ChatGPT OAuth 连接 Codex，不在模型设置中读取或回显 token。",
    id: "openai-codex",
    label: "Codex",
    recommended: false,
    recommended_model: "gpt-5.4"
  },
  {
    api: "anthropic",
    auth: "api_key",
    base_url: "https://api.anthropic.com/v1",
    description: "使用 Anthropic API key 与官方模型目录。",
    id: "anthropic",
    label: "Anthropic",
    recommended: false,
    recommended_model: "claude-sonnet-4-6"
  }
];

export function registerPiProviderSettingsRoutes(
  router: Router,
  context: PiProviderSettingsContext
): void {
  const activeContext = { ...context, secrets: context.secrets ?? createDatabaseSecretService(context.database) };
  router.get("/api/pi/provider-settings", async () => json(await listProviderSettings(activeContext)));
  router.get("/api/pi/provider-settings/catalog", () => json(providerCatalog()));
  router.put("/api/pi/provider-settings/:id", async (request) => {
    return json(await upsertProviderSettings(activeContext, providerID(request), await parseObjectBody(request)));
  });
  router.post("/api/pi/provider-settings/:id/test-connection", async (request) => {
    return json(await testProviderConnection(activeContext, providerID(request), await parseObjectBody(request)));
  });
}

async function listProviderSettings(context: PiProviderSettingsContext) {
  const config = await readModelsConfig(modelsPath(context.database));
  return { providers: Object.entries(config.providers).map((entry) => publicProviderSettings(entry, context.secrets)) };
}

async function upsertProviderSettings(
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
  const publicSettings = publicProviderSettings([id, next], context.secrets);
  recordProviderSettingsAudit(context.database, id, body, publicSettings);
  return publicSettings;
}

function providerCatalog() {
  return {
    presets: PROVIDER_PRESETS.map((preset) => ({
      ...preset,
      models: builtinModelCatalog(preset.id)
    }))
  };
}

async function testProviderConnection(
  context: PiProviderSettingsContext,
  id: string,
  body: Record<string, unknown>
): Promise<ProviderConnectionResult> {
  const config = await readModelsConfig(modelsPath(context.database));
  const current = config.providers[id] ?? {};
  const preset = PROVIDER_PRESETS.find((item) => item.id === id);
  const auth = preset?.auth ?? "api_key";
  const startedAt = Date.now();
  let result: ProviderConnectionResult;
  if (auth === "oauth") {
    result = await oauthConnectionResult(context.database, id);
  } else {
    result = await probeApiKeyProvider(id, body, current, preset, context.secrets!);
  }
  recordProviderConnectionAudit(context.database, id, body, current, preset, result, Date.now() - startedAt);
  return result;
}

async function oauthConnectionResult(database: RunnerDatabase, id: string): Promise<ProviderConnectionResult> {
  const configured = id === "openai-codex" && await isPiOpenAICodexOAuthConfigured(database);
  return {
    auth: "oauth",
    checked_at: new Date().toISOString(),
    ...(!configured ? { error: "oauth_not_configured" } : {}),
    message: configured ? "OAuth credential is configured" : "请先完成 Codex OAuth 登录",
    models: builtinModelIDs(id),
    ok: configured,
    provider_id: id,
    status: configured ? "connected" : "failed"
  };
}

async function probeApiKeyProvider(
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

function providerModelsURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 仅支持 http/https");
  if (url.username || url.password) throw new Error("Base URL 不能包含凭据");
  if (url.search || url.hash) throw new Error("Base URL 不能包含 query 或 fragment");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  return url;
}

function providerDiscoveryHeaders(api: string, apiKey: string): Record<string, string> {
  if (api === "anthropic") {
    return { Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
  }
  if (api === "google") return { Accept: "application/json", "x-goog-api-key": apiKey };
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

async function discoveredModelIDs(response: Response): Promise<string[]> {
  const raw = await response.json().catch(() => null);
  if (!isObject(raw)) return [];
  const values = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  return [...new Set(values.map((item) => discoveredModelID(item)).filter(Boolean))].slice(0, 200);
}

function discoveredModelID(value: unknown): string {
  const raw = isObject(value) ? cleanString(value.id) || cleanString(value.name) : cleanString(value);
  const id = raw.replace(/^models\//, "");
  return id.length <= 256 ? id : "";
}

async function readModelsConfig(path: string): Promise<ModelsConfig> {
  try {
    return normalizeModelsConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return { providers: {} };
    if (error instanceof SyntaxError) throw new HttpError(400, "PI models.json 不是合法 JSON");
    throw error;
  }
}

async function writeModelsConfig(path: string, config: ModelsConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function normalizeModelsConfig(value: unknown): ModelsConfig {
  const raw = isObject(value) ? value : {};
  const providers = isObject(raw.providers) ? raw.providers : {};
  const normalized: ModelsConfig = { providers: {} };
  for (const [id, provider] of Object.entries(providers)) {
    if (!isObject(provider)) continue;
    normalized.providers[id] = {
      ...provider,
      api: cleanString(provider.api),
      apiKey: cleanString(provider.apiKey),
      apiKeyRef: cleanString(provider.apiKeyRef),
      baseUrl: cleanString(provider.baseUrl),
      headers: isStringRecord(provider.headers) ? provider.headers : undefined,
      models: normalizeModels(provider.models, id),
      modelOverrides: normalizeModelOverrides(provider.modelOverrides)
    };
  }
  return normalized;
}

function normalizeProviderConfig(
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
    baseUrl: cleanString(body.base_url) || cleanString(body.baseUrl) || current.baseUrl || "",
    headers: nextHeaders(current.headers, body),
    models: selection.models,
    modelOverrides: selection.modelOverrides
  });
}

function normalizeModels(value: unknown, providerID: string): ProviderModelConfig[] {
  if (typeof value === "string") return modelIDsFromText(value).map((id) => modelConfig(providerID, id));
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeModel(providerID, item))
    .filter((model): model is ProviderModelConfig => !!model);
}

function normalizeModelSelection(
  value: unknown,
  providerID: string
): { models: ProviderModelConfig[]; modelOverrides: Record<string, ProviderModelOverrideConfig> } {
  const models: ProviderModelConfig[] = [];
  const modelOverrides: Record<string, ProviderModelOverrideConfig> = {};
  for (const item of modelItems(value)) {
    const id = cleanString(isObject(item) ? item.id : item);
    if (!id) continue;
    if (knownModel(providerID, id)) modelOverrides[id] = normalizeModelOverride(item);
    else models.push(normalizeModel(providerID, item) ?? { id });
  }
  return { models, modelOverrides };
}

function modelItems(value: unknown): unknown[] {
  if (typeof value === "string") return modelIDsFromText(value);
  return Array.isArray(value) ? value : [];
}

function normalizeModel(providerID: string, value: unknown): ProviderModelConfig | undefined {
  const id = cleanString(isObject(value) ? value.id : value);
  if (!id) return undefined;
  return stripUndefined({
    ...modelConfig(providerID, id),
    ...(isObject(value) ? value : {}),
    id
  });
}

function normalizeModelOverrides(value: unknown): Record<string, ProviderModelOverrideConfig> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([id, override]) => [cleanString(id), normalizeModelOverride(override)])
    .filter(([id]) => id !== ""));
}

function normalizeModelOverride(value: unknown): ProviderModelOverrideConfig {
  if (!isObject(value)) return {};
  return stripUndefined({
    name: typeof value.name === "string" ? value.name : undefined,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    thinkingLevelMap: isObject(value.thinkingLevelMap)
      ? value.thinkingLevelMap as Record<string, string | null>
      : undefined,
    input: Array.isArray(value.input) ? value.input.filter(isModelInput) : undefined,
    cost: isModelCost(value.cost) ? value.cost : undefined,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined,
    headers: isStringRecord(value.headers) ? value.headers : undefined,
    compat: isObject(value.compat) ? value.compat : undefined
  });
}

function modelConfig(providerID: string, id: string): ProviderModelConfig {
  const model = knownModel(providerID, id);
  if (!model) return { id };
  return stripUndefined({
    id,
    api: undefined,
    baseUrl: undefined,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat as Record<string, unknown> | undefined
  });
}

function knownModel(providerID: string, id: string) {
  const lookup = getModel as unknown as (provider: string, modelID: string) => Model<any> | undefined;
  return lookup(providerID, id);
}

function modelIDsFromText(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function publicProviderSettings([id, provider]: [string, ProviderConfig], secrets?: SecretService): PublicProviderSettings {
  return {
    id,
    api: provider.api ?? "",
    api_key_configured: providerCredentialConfigured(provider, secrets),
    base_url: provider.baseUrl ?? "",
    models: publicModelIDs(provider),
    user_agent: userAgentFromHeaders(provider.headers)
  };
}

function providerCredentialConfigured(provider: ProviderConfig, secrets?: SecretService): boolean {
  if (cleanString(provider.apiKey) !== "") return true;
  const ref = cleanString(provider.apiKeyRef);
  if (ref === "" || !secrets) return false;
  return secrets.describe(ref)?.status === "active";
}

function providerSecretName(providerID: string): string {
  return `pi/provider/${encodeURIComponent(providerID)}/api-key`;
}

function nextHeaders(current: Record<string, string> | undefined, body: Record<string, unknown>): Record<string, string> | undefined {
  const headers = { ...(current ?? {}) };
  if (!hasOwn(body, "user_agent") && !hasOwn(body, "userAgent")) return emptyAsUndefined(headers);
  const userAgent = cleanString(body.user_agent) || cleanString(body.userAgent);
  if (userAgent === "") delete headers["User-Agent"];
  else headers["User-Agent"] = userAgent;
  return emptyAsUndefined(headers);
}

function emptyAsUndefined(value: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

function userAgentFromHeaders(headers: Record<string, string> | undefined): string {
  return cleanString(headers?.["User-Agent"]);
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return isObject(body) ? body : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function providerID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = decodeURIComponent(parts[parts.indexOf("provider-settings") + 1] ?? "").trim();
  if (value === "") throw new HttpError(400, "provider id 不能为空");
  return value;
}

function modelsPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "models.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicModelIDs(provider: ProviderConfig): string[] {
  const ids = [
    ...(provider.models ?? []).map((model) => model.id),
    ...Object.keys(provider.modelOverrides ?? {})
  ].filter(Boolean);
  return [...new Set(ids)];
}

function builtinModelCatalog(providerID: string) {
  if (!getProviders().includes(providerID as KnownProvider)) return [];
  return getModels(providerID as KnownProvider).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning
  }));
}

function builtinModelIDs(providerID: string): string[] {
  return builtinModelCatalog(providerID).map((model) => model.id);
}

function recordProviderSettingsAudit(
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

function recordProviderConnectionAudit(
  database: RunnerDatabase,
  providerID: string,
  body: Record<string, unknown>,
  current: ProviderConfig,
  preset: ProviderPreset | undefined,
  result: ProviderConnectionResult,
  durationMs: number
): void {
  const api = cleanString(body.api) || current.api || preset?.api || "";
  const baseUrl = cleanString(body.base_url) || cleanString(body.baseUrl) || current.baseUrl || preset?.base_url || "";
  createPiActionEvent(database, {
    action_id: `provider-connection-test:${providerID}:${crypto.randomUUID()}`,
    actor: "user",
    error: result.error || "",
    event_type: "provider_connection_tested",
    payload_json: JSON.stringify({
      api,
      auth: result.auth,
      base_url: auditBaseUrl(baseUrl),
      provider_id: providerID,
      source: "settings_http"
    }),
    reason: `tested provider connection for ${providerID}`,
    result_json: JSON.stringify({
      discovered_model_count: result.models.length,
      duration_ms: Math.max(0, Math.round(durationMs)),
      http_status: result.http_status,
      status: result.status
    })
  });
}

function auditBaseUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

function isModelInput(value: unknown): value is "text" | "image" {
  return value === "text" || value === "image";
}

function isModelCost(value: unknown): value is ProviderModelConfig["cost"] {
  return isObject(value) &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
