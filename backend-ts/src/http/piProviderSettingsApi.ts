import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiProviderSettingsContext = { database: RunnerDatabase };
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

export function registerPiProviderSettingsRoutes(
  router: Router,
  context: PiProviderSettingsContext
): void {
  router.get("/api/pi/provider-settings", async () => json(await listProviderSettings(context)));
  router.put("/api/pi/provider-settings/:id", async (request) => {
    return json(await upsertProviderSettings(context, providerID(request), await parseObjectBody(request)));
  });
}

async function listProviderSettings(context: PiProviderSettingsContext) {
  const config = await readModelsConfig(modelsPath(context.database));
  return { providers: Object.entries(config.providers).map(publicProviderSettings) };
}

async function upsertProviderSettings(
  context: PiProviderSettingsContext,
  id: string,
  body: Record<string, unknown>
): Promise<PublicProviderSettings> {
  const path = modelsPath(context.database);
  const config = await readModelsConfig(path);
  const current = config.providers[id] ?? {};
  const next = normalizeProviderConfig(id, body, current);
  config.providers[id] = next;
  await writeModelsConfig(path, config);
  return publicProviderSettings([id, next]);
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
  current: ProviderConfig
): ProviderConfig {
  const api = cleanString(body.api) || current.api || "";
  if (api === "") throw new HttpError(400, "api is required");
  const selection = hasOwn(body, "models")
    ? normalizeModelSelection(body.models, id)
    : { models: current.models ?? [], modelOverrides: current.modelOverrides ?? {} };
  return {
    ...current,
    api,
    apiKey: cleanString(body.api_key) || cleanString(body.apiKey) || current.apiKey || "",
    baseUrl: cleanString(body.base_url) || cleanString(body.baseUrl) || current.baseUrl || "",
    headers: nextHeaders(current.headers, body),
    models: selection.models,
    modelOverrides: selection.modelOverrides
  };
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
    if (getModel(providerID, id)) modelOverrides[id] = normalizeModelOverride(item);
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
  const model = getModel(providerID, id);
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

function modelIDsFromText(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function publicProviderSettings([id, provider]: [string, ProviderConfig]): PublicProviderSettings {
  return {
    id,
    api: provider.api ?? "",
    api_key_configured: cleanString(provider.apiKey) !== "",
    base_url: provider.baseUrl ?? "",
    models: publicModelIDs(provider),
    user_agent: userAgentFromHeaders(provider.headers)
  };
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
