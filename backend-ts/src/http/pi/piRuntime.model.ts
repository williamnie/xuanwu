import { type Model } from "@earendil-works/pi-ai/compat";
import type { RunnerConfig } from "../../config/env.ts";
import type { PiAgent } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import type { PiGatePolicy } from "../../pi/actions/actionGate.ts";
import type { EventBus } from "../../events/bus.ts";
import type { SupervisorContextResolution } from "../../pi/supervisor/supervisorContextResolver.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import type { ProviderCatalogEntry } from "../../providers/core/catalog.ts";
import type { SystemRestartAuditEvent } from "../system/systemRestartApi.ts";
import type { PiChatToolMode, PiRuntimePromptProfile } from "../../pi/runtime/runtimePromptProfile.ts";
import type { AppLanguage } from "../../i18n/language.ts";
import type { createPiRuntimeSession } from "./piRuntime.createPiRuntimeSession.ts";

export type PiRuntimeResult = { piSessionId: string; sessionFile: string };

export type PiRuntimeSession = Awaited<ReturnType<typeof createPiRuntimeSession>>;

export type RuntimeSessionInput = {
  agent: PiAgent;
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  authorization?: PiGatePolicy;
  bus?: EventBus;
  channelContext?: string;
  chatToolMode?: PiChatToolMode;
  codeAgentCatalog?: readonly ProviderCatalogEntry[];
  cliConnectorDirs?: string[];
  conversationID: string;
  config?: RunnerConfig;
  delegationID?: string;
  env?: Record<string, string | undefined>;
  heartbeatID?: string;
  issueID?: number;
  notificationTarget?: {
    connectorID: string;
    conversationID: string;
    replyToMessageID?: string;
    threadID?: string;
  };
  outputLanguage?: AppLanguage;
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
  promptProfile: PiRuntimePromptProfile;
  memoryReflection?: import("../../pi/memory/memoryReflectionQueue.ts").ReflectionLease;
  issueRunID?: string;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
  retry?: {
    baseDelayMs?: number;
    enabled?: boolean;
    maxRetries?: number;
    provider?: { maxRetries?: number; maxRetryDelayMs?: number; timeoutMs?: number };
  };
  sessionFile?: string;
  source?: string;
  sourceTurn?: { id?: string; source?: string; userPrompt?: string };
  supervisorContext?: SupervisorContextResolution;
  supervisorManaged?: boolean;
  toolProject?: Project;
};

export type RuntimeCleanup = () => void;

export type PiModelRegistry = { find(provider: string, modelID: string): Model<any> | undefined };
