import type { RunnerDatabase } from "../../db/database.ts";
import { type PiOpenAICodexModelDiscovery } from "./piOAuthApi.ts";
import { type SecretService } from "../../security/secrets/service.ts";

export type PiProviderSettingsContext = {
  database: RunnerDatabase;
  piOpenAICodexModelDiscovery?: PiOpenAICodexModelDiscovery;
  secrets?: SecretService;
};

export type ModelsConfig = { providers: Record<string, ProviderConfig> };

export type ProviderModelConfig = {
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

export type ProviderModelOverrideConfig = Omit<ProviderModelConfig, "id" | "api" | "baseUrl">;

export type ProviderConfig = {
  api?: string;
  apiKey?: string;
  apiKeyRef?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: ProviderModelConfig[];
  modelOverrides?: Record<string, ProviderModelOverrideConfig>;
  [key: string]: unknown;
};

export type PublicProviderSettings = {
  api: string;
  api_key_configured: boolean;
  base_url: string;
  id: string;
  in_use: boolean;
  models: string[];
  user_agent: string;
};

export type ProviderAuthMode = "api_key" | "oauth";

export type ProviderPreset = {
  api: string;
  auth: ProviderAuthMode;
  base_url: string;
  description: string;
  id: string;
  label: string;
  recommended: boolean;
  recommended_model: string;
};

export type ProviderConnectionResult = {
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
