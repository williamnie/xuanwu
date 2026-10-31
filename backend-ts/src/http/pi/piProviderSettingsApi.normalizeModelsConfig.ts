import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { RunnerDatabase } from "../../db/database.ts";
import { HttpError } from "../errors.ts";
import { type SecretService } from "../../security/secrets/service.ts";
import { cleanString, isRecord } from "../../util/values.ts";
import type { ProviderPreset, ModelsConfig, ProviderModelConfig, ProviderModelOverrideConfig, ProviderConfig } from "./piProviderSettingsApi.model.ts";

export const PROVIDER_PRESETS: ProviderPreset[] = [
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

export async function readModelsConfig(path: string): Promise<ModelsConfig> {
  try {
    return normalizeModelsConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return { providers: {} };
    if (error instanceof SyntaxError) throw new HttpError(400, "PI models.json 不是合法 JSON");
    throw error;
  }
}

export function normalizeModelsConfig(value: unknown): ModelsConfig {
  const raw = isRecord(value) ? value : {};
  const providers = isRecord(raw.providers) ? raw.providers : {};
  const normalized: ModelsConfig = { providers: {} };
  for (const [id, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    normalized.providers[id] = stripUndefined({
      ...provider,
      api: cleanString(provider.api),
      apiKey: cleanString(provider.apiKey) || undefined,
      apiKeyRef: cleanString(provider.apiKeyRef) || undefined,
      baseUrl: cleanString(provider.baseUrl) || undefined,
      headers: isStringRecord(provider.headers) ? provider.headers : undefined,
      models: normalizeModels(provider.models, id),
      modelOverrides: normalizeModelOverrides(provider.modelOverrides)
    });
  }
  return normalized;
}

export function normalizeModels(value: unknown, providerID: string): ProviderModelConfig[] {
  if (typeof value === "string") return modelIDsFromText(value).map((id) => modelConfig(providerID, id));
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeModel(providerID, item))
    .filter((model): model is ProviderModelConfig => !!model);
}

export function normalizeModel(providerID: string, value: unknown): ProviderModelConfig | undefined {
  const id = cleanString(isRecord(value) ? value.id : value);
  if (!id) return undefined;
  return stripUndefined({
    ...modelConfig(providerID, id),
    ...(isRecord(value) ? value : {}),
    id
  });
}

export function normalizeModelOverrides(value: unknown): Record<string, ProviderModelOverrideConfig> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([id, override]) => [cleanString(id), normalizeModelOverride(override)])
    .filter(([id]) => id !== ""));
}

export function normalizeModelOverride(value: unknown): ProviderModelOverrideConfig {
  if (!isRecord(value)) return {};
  return stripUndefined({
    name: typeof value.name === "string" ? value.name : undefined,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    thinkingLevelMap: isRecord(value.thinkingLevelMap)
      ? value.thinkingLevelMap as Record<string, string | null>
      : undefined,
    input: Array.isArray(value.input) ? value.input.filter(isModelInput) : undefined,
    cost: isModelCost(value.cost) ? value.cost : undefined,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined,
    headers: isStringRecord(value.headers) ? value.headers : undefined,
    compat: isRecord(value.compat) ? value.compat : undefined
  });
}

export function modelConfig(providerID: string, id: string): ProviderModelConfig {
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

export function knownModel(providerID: string, id: string) {
  const lookup = getModel as unknown as (provider: string, modelID: string) => Model<any> | undefined;
  return lookup(providerID, id);
}

export function modelIDsFromText(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

export function providerCredentialConfigured(provider: ProviderConfig, secrets?: SecretService): boolean {
  if (cleanString(provider.apiKey) !== "") return true;
  const ref = cleanString(provider.apiKeyRef);
  if (ref === "" || !secrets) return false;
  return secrets.describe(ref)?.status === "active";
}

export function userAgentFromHeaders(headers: Record<string, string> | undefined): string {
  return cleanString(headers?.["User-Agent"]);
}

export function modelsPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "models.json");
}

export function publicModelIDs(provider: ProviderConfig): string[] {
  const ids = [
    ...(provider.models ?? []).map((model) => model.id),
    ...Object.keys(provider.modelOverrides ?? {})
  ].filter(Boolean);
  return [...new Set(ids)];
}

export function isModelInput(value: unknown): value is "text" | "image" {
  return value === "text" || value === "image";
}

export function isModelCost(value: unknown): value is ProviderModelConfig["cost"] {
  return isRecord(value) &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number";
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
