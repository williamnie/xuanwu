import type { RunnerConfig } from "../../config/env.ts";
import type { FeishuReceiverStatus } from "../../integrations/feishu/feishuReceiver.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { ProviderRegistry } from "../../providers/core/registry.ts";

export type SystemStatusContext = {
  authEnabled: boolean;
  config: RunnerConfig;
  database: RunnerDatabase;
  feishuReceiverStatus?: () => FeishuReceiverStatus;
  processGroupMemory?: { snapshot(): Record<string, unknown> };
  projectionWorker?: { snapshot(): Record<string, unknown> };
  /** P4：registry 装配后由 registry.list() 投影 providers，替代手写 codex/claude switch */
  providersRegistry?: ProviderRegistry;
  role?: "all" | "core";
  startedAt: Date;
  webhookSigningSecret?: string;
};

export type CheckStatus = { ok: boolean; error?: string };

export type ProviderStatus = {
  available: boolean;
  capabilities: string[];
  cli: Record<string, unknown>;
  command: string;
  cwd_configured: boolean;
  default_model?: string;
  enabled: boolean;
  env_keys: string[];
  id: string;
  label: string;
  role: string;
  secrets: Record<string, { configured: boolean }>;
  settings_mode: string;
  status: string;
  timeout_ms: number;
  mode?: string;
  ready?: boolean;
  readiness_reason?: string;
  sdk?: Record<string, unknown>;
  api_base_url_summary?: string;
  api_key_configured?: boolean;
  auth_configured?: boolean;
  auth_mode?: string;
  auth_source?: string;
  local_cli?: Record<string, unknown>;
  platform_profile?: Record<string, unknown>;
  /** P4 registry 投影附加字段 */
  registry_state?: string;
  support_level?: string;
  runtime_version?: string;
  failure?: { category: string; message: string };
};

export type RuntimeStatus = {
  auth: { enabled: boolean };
  config: { addr: string; db_path: string };
  db: CheckStatus;
  connectors: Array<Record<string, unknown>>;
  connector_health: Array<Record<string, unknown>>;
  event_projection: Record<string, unknown>;
  health: Record<string, unknown>;
  observability: Record<string, unknown>;
  process_group_memory: Record<string, unknown>;
  providers: ProviderStatus[];
  run_progress_projection: Record<string, unknown>;
  runner: Record<string, number>;
  security: Record<string, unknown>;
  service: Record<string, unknown>;
};
