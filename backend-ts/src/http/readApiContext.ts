import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { PiOpenAICodexOAuthLogin } from "./piOAuthApi.ts";

export type ReadApiContext = {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};
