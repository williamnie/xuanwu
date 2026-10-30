import type { RunnerDatabase } from "../../db/database.ts";
import { type ImInteractionBindingAction } from "../../db/repositories/imInteractionBindings.ts";
import type { EventBus } from "../../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import type { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { type ImInteractionCallback } from "../im/imInteractionService.ts";

export type FeishuImInteraction = {
  callback: ImInteractionCallback;
  chatID: string;
  messageID: string;
  userID: string;
  userOpenID: string;
};

export type FeishuImInteractionContext = {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  bus?: EventBus;
  config: FeishuConnectorConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type LegacyInteractionInput = {
  actionID: string;
  actionKind: string;
  actionRef: string;
  actions: ImInteractionBindingAction[];
  actor: { id?: string; openId?: string };
  bindingActor: { id?: string; openId?: string };
  bindingScopeKey: string;
  businessRef: string;
  chatID: string;
  eventID: string;
  expiresAt: string;
  messageID: string;
};
