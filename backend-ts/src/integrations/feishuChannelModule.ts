import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { OutboundEnvelope } from "./channelConnectorContracts.ts";
import type { GuardianAlertDelivery } from "../pi/guardianAlertDelivery.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import {
  createFeishuMessageClient,
  type FeishuMessageClient
} from "./feishuClient.ts";
import {
  createFeishuChannelConnector,
  FEISHU_CONNECTOR_ID
} from "./feishuChannelConnector.ts";
import {
  createFeishuReceiverManager,
  type FeishuReceiverStatus
} from "./feishuReceiver.ts";
import {
  createFeishuAgentBridge,
  type FeishuConversationRunner
} from "./feishuAgentBridge.ts";
import { buildFeishuConversationPromptContext } from "./feishuConversationContext.ts";
import { sendDirectFeishuGuardianAlert } from "./feishuGuardianAlerts.ts";
import { attachFeishuNotificationObservers } from "./feishuNotifications.ts";
import {
  createImChannelRegistry,
  type ImChannelModule,
  type ImChannelModuleInternals,
  type ImChannelRegistryOptions,
  type ImReceiverAdapter
} from "./imChannelContracts.ts";

/**
 * Feishu IM channel module (design 2026-08-02 §4.1/§10): aggregates the
 * provider-private transport client, receiver lifecycle and presentation
 * boundary behind the generic `ImChannelModule` contract. Runtime/HTTP code
 * assembles through this module instead of constructing Feishu pieces
 * directly; the registry hands out only the connector/presentation surface.
 */

export type FeishuChannelModuleOptions = {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  bus?: EventBus;
  config: () => FeishuConnectorConfig;
  database: RunnerDatabase;
  /** Assembly-time transport override (tests); production leaves it unset. */
  sender?: FeishuMessageClient;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runSupervisorConversation?: (input: {
    channelContext: string;
    conversationId: string;
    prompt: string;
    targetIssueId?: number;
    targetProjectId: string;
    targetProjectSource?: string;
    title: string;
  }) => Promise<{ conversationId?: string; targetProjectId?: string; text: string }>;
};

export type FeishuChannelModule = ImChannelModuleInternals<FeishuConnectorConfig, FeishuMessageClient> & {
  /** Provider-private compatibility handle for the Feishu callback route. */
  readonly agentBridge: ReturnType<typeof createFeishuAgentBridge>;
  /** Provider-private: registered on the HTTP callback route by the server. */
  readonly receiverStatus: () => FeishuReceiverStatus;
  readonly guardianAlertDelivery: GuardianAlertDelivery;
};

export function createFeishuChannelModule(options: FeishuChannelModuleOptions): FeishuChannelModule {
  const config = options.config;
  const connector = createFeishuChannelConnector({ config, sender: options.sender });
  const agentBridge = options.agentBridge ?? createFeishuAgentBridge({
    config,
    connector,
    database: options.database,
    runConversation: supervisorConversationRunner(options),
    sender: options.sender
  });
  const receiverManager = createFeishuReceiverManager({
    agentBridge,
    bus: options.bus,
    database: options.database,
    providers: options.providers
  });
  const receiver: ImReceiverAdapter = {
    start: () => receiverManager.restart(config()),
    stop: () => receiverManager.stop(),
    restart: () => receiverManager.restart(config()),
    status: () => {
      const current = receiverManager.status();
      return {
        connector_id: FEISHU_CONNECTOR_ID,
        connected: current.connected,
        last_error: current.last_error,
        last_event_at: current.last_event_at,
        reconnect_attempts: current.reconnect_attempts,
        state: current.state
      };
    }
  };
  let detachNotifications: (() => void) | undefined;

  const module: ImChannelModule = {
    callback: {
      handle: async (request) => {
        const { handleFeishuEvent } = await import("../http/feishuEventsApi.ts");
        return handleFeishuEvent(request, {
          agentBridge,
          bus: options.bus,
          config: config(),
          database: options.database,
          providers: options.providers
        });
      },
      path: "/api/integrations/feishu/events"
    },
    configuration: {
      fields: [
        { id: "enabled", kind: "boolean", label: "Enabled", required: false, write_only: false },
        { id: "app_id", kind: "string", label: "App ID", required: true, write_only: false },
        { id: "app_secret", kind: "secret", label: "App Secret", required: true, write_only: true },
        { id: "verification_token", kind: "secret", label: "Verification Token", required: false, write_only: true },
        { id: "encrypt_key", kind: "secret", label: "Encrypt Key", required: false, write_only: true },
        { id: "receive_mode", kind: "enum", label: "Receive Mode", options: ["websocket", "callback"], required: true, write_only: false },
        { id: "allowed_chat_ids", kind: "string_list", label: "Allowed Chat IDs", required: false, write_only: false },
        { id: "allowed_user_ids", kind: "string_list", label: "Allowed User IDs", required: false, write_only: false },
        { id: "default_chat_id", kind: "string", label: "Default Chat ID", required: false, write_only: false },
        { id: "default_project_id", kind: "string", label: "Default Project ID", required: false, write_only: false },
        { id: "project_mappings", kind: "string_list", label: "Project Mappings", required: false, write_only: false }
      ],
      mode: "provider_specific",
      settings_path: "/api/integrations/feishu/settings"
    },
    connector,
    id: FEISHU_CONNECTOR_ID,
    notifications: {
      start: () => {
        if (detachNotifications || !options.bus) return;
        detachNotifications = attachFeishuNotificationObservers({
          bus: options.bus,
          config: config(),
          connector,
          database: options.database,
          sender: options.sender
        });
      },
      stop: () => {
        detachNotifications?.();
        detachNotifications = undefined;
      }
    },
    presentation: {
      // Presentation stays inside the provider connector; this adapter exists
      // so registry consumers can deliver canonical envelopes without holding
      // the provider client.
      deliver: (envelope: OutboundEnvelope) => connector.deliver!(envelope)
    },
    receiver
  };

  return {
    agentBridge,
    guardianAlertDelivery: {
      connectorID: FEISHU_CONNECTOR_ID,
      send: (alert, deliveryOptions = {}) => sendDirectFeishuGuardianAlert(options.database, alert, {
        config: config(),
        connector,
        formatText: deliveryOptions.formatText,
        now: deliveryOptions.now,
        sender: options.sender
      })
    },
    module,
    onConfigChanged: (next) => receiverManager.restart(next),
    receiverStatus: () => receiverManager.status(),
    sender: (next) => options.sender ?? createFeishuMessageClient({ config: next })
  };
}

function supervisorConversationRunner(options: FeishuChannelModuleOptions): FeishuConversationRunner | undefined {
  if (!options.runSupervisorConversation) return undefined;
  return async ({ conversationId, event, prompt, targetIssueId, targetProjectId, targetProjectSource }) => {
    const targetProject = targetProjectId ?? "";
    const result = await options.runSupervisorConversation!({
      channelContext: buildFeishuConversationPromptContext(options.database, { event }),
      conversationId,
      prompt,
      targetIssueId,
      targetProjectId: targetProject,
      targetProjectSource,
      title: `Feishu · ${event.chat_id || event.message_id}`
    });
    return {
      conversationId: result.conversationId,
      projectId: "",
      targetProjectId: result.targetProjectId ?? targetProject,
      text: result.text
    };
  };
}

/**
 * Built-in compile-time registry: modules are registered explicitly; runtime
 * code resolves connectors by outbox `source`/connector id. New channels add
 * one registration call here instead of touching business modules.
 */
export function createBuiltinImChannelRegistry(options: {
  feishu?: ImChannelModule;
  telegram?: ImChannelModule;
  require?: ImChannelRegistryOptions["require"];
}) {
  const registry = createImChannelRegistry({
    require: options.require ?? ["message.receive", "message.reply"]
  });
  if (options.feishu) registry.register(options.feishu);
  if (options.telegram) registry.register(options.telegram);
  return registry;
}
