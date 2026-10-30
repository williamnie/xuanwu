import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { type ConnectorManifest } from "./channelConnectorContracts.ts";
import { type SecretService } from "../security/secrets/service.ts";
import type { FeishuReceiverStatus } from "./feishu/feishuReceiver.ts";

export type ConnectorDiagnosticState =
  | "unconfigured"
  | "unknown"
  | "healthy"
  | "degraded"
  | "rate_limited"
  | "disconnected"
  | "failed"
  | "revoked";

export type ConnectorProbeResult = {
  checked_at: string;
  error?: { code: string; message: string };
  http_status?: number;
  ok: boolean;
  rate_limit?: { retry_after_seconds: number; reset_at: string };
  state: ConnectorDiagnosticState;
};

export type ConnectorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ConnectorDiagnosticsContext = {
  config: RunnerConfig;
  database: RunnerDatabase;
  feishuReceiverStatus?: FeishuReceiverStatus;
  now?: () => Date;
  secrets?: SecretService;
  webhookSigningSecret?: string;
};

export type StaticConnectorDefinition = {
  configured: boolean;
  manifest: ConnectorManifest;
  missing_required: string[];
  secret_refs: Array<Record<string, unknown>>;
  source: string;
  source_of_truth: string;
  test_supported: boolean;
};
