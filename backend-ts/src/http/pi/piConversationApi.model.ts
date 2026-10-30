import type { RunnerConfig } from "../../config/env.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { type ImContextProjectionReservation } from "../../db/repositories/imContextLifecycle.ts";
import { type PiConversation } from "../../db/repositories/pi.ts";
import type { EventBus } from "../../events/bus.ts";
import type { PiRuntimeSession } from "./piRuntime.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import type { ProviderRegistry } from "../../providers/core/registry.ts";
import type { SystemRestartAuditEvent } from "../system/systemRestartApi.ts";
import { type ImConversationPromptProjection } from "../../integrations/im/imConversationContext.ts";
import { type AppLanguage } from "../../i18n/language.ts";

export type PiConversationContext = {
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  bus?: EventBus;
  config?: RunnerConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  providersRegistry?: ProviderRegistry;
  restartDelayMs?: number;
  restartProcess?: () => void;
  supervisorManaged?: boolean;
};

export type PiConversationPromptInput = {
  channelContext?: string;
  channelContextProjection?: ImConversationPromptProjection;
  continuationContext?: string;
  clearProjectId?: boolean;
  conversationId?: string;
  intent?: string;
  language?: AppLanguage;
  projectId?: string;
  prompt: string;
  targetProjectId?: string;
  targetProjectSource?: string;
  targetIssueId?: number;
  title?: string;
};

export type PiConversationTurn = {
  contextReservation?: ImContextProjectionReservation;
  conversation: PiConversation;
  prompt: string;
  runtime: PiRuntimeSession;
  turnID: string;
};

export type PiConversationTurnResult = {
  conversation_id: string;
  message_count: number;
  pi_session_id: string;
  session_file: string;
  status: "completed" | "failed";
  text: string;
  title: string;
  turn_id: string;
};
