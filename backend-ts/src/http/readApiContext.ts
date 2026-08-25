import type { RunnerConfig } from "../config/env.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { ProviderRegistry } from "../providers/core/registry.ts";
import type { PiOpenAICodexOAuthLogin } from "./piOAuthApi.ts";
import type { SystemRestartAuditEvent } from "./systemRestartApi.ts";

export type ReadApiContext = {
  agenticClient?: AgenticWorkerClient;
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  readDatabase?: RunnerDatabase;
  interruptTimeoutMs?: number;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  providersRegistry?: ProviderRegistry;
  restartDelayMs?: number;
  restartProcess?: () => void;
  supervisorManaged?: boolean;
  webhookSigningSecret?: string;
};
