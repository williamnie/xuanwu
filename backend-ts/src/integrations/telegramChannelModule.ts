import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { OutboundEnvelope } from "./channelConnectorContracts.ts";
import {
  type ImChannelModule,
  type ImChannelModuleInternals,
  type ImReceiverAdapter
} from "./imChannelContracts.ts";
import { createTelegramAgentBridge, type TelegramSupervisorConversation } from "./telegramAgentBridge.ts";
import { createTelegramChannelConnector, TELEGRAM_CONNECTOR_ID } from "./telegramChannelConnector.ts";
import { createTelegramBotClient, type TelegramBotClient } from "./telegramClient.ts";
import { createTelegramReceiverManager } from "./telegramReceiver.ts";
import type { TelegramConnectorConfig } from "./telegramTypes.ts";

export type TelegramChannelModuleOptions = {
  bus?: EventBus;
  client?: TelegramBotClient;
  config: () => TelegramConnectorConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runSupervisorConversation?: TelegramSupervisorConversation;
};

export type TelegramChannelModule = ImChannelModuleInternals<TelegramConnectorConfig, TelegramBotClient> & {
  readonly agentBridge: ReturnType<typeof createTelegramAgentBridge>;
};

export function createTelegramChannelModule(options: TelegramChannelModuleOptions): TelegramChannelModule {
  const connector = createTelegramChannelConnector({
    config: options.config,
    database: options.database,
    sender: options.client
  });
  const agentBridge = createTelegramAgentBridge({
    config: options.config,
    connector,
    database: options.database,
    runSupervisorConversation: options.runSupervisorConversation
  });
  const receiverManager = createTelegramReceiverManager({
    bus: options.bus,
    client: options.client,
    database: options.database,
    onMessage: async (input) => { await agentBridge.handle(input); },
    presentInteractionResult: agentBridge.presentInteractionResult,
    projectSelection: agentBridge.resolveProjectSelection,
    providers: options.providers
  });
  const receiver: ImReceiverAdapter = {
    restart: () => receiverManager.restart(options.config()),
    start: () => receiverManager.restart(options.config()),
    status: () => receiverManager.status(),
    stop: () => receiverManager.stop()
  };
  const module: ImChannelModule = {
    configuration: {
      fields: [
        { id: "enabled", kind: "boolean", label: "Enabled", required: false, write_only: false },
        { id: "bot_token", kind: "secret", label: "Bot token", required: true, write_only: true },
        { id: "allowed_chat_ids", kind: "string_list", label: "Allowed chat IDs", required: true, write_only: false },
        { id: "allowed_user_ids", kind: "string_list", label: "Allowed user IDs", required: true, write_only: false },
        { id: "default_chat_id", kind: "string", label: "Default chat ID", required: false, write_only: false },
        { id: "project_mappings", kind: "string_list", label: "Project mappings", required: false, write_only: false },
        { id: "poll_timeout_seconds", kind: "string", label: "Poll timeout seconds", required: false, write_only: false },
        { id: "get_me_cache_ttl_seconds", kind: "string", label: "getMe cache TTL seconds", required: false, write_only: false }
      ],
      mode: "provider_specific",
      settings_path: "/api/integrations/telegram/settings"
    },
    connector,
    id: TELEGRAM_CONNECTOR_ID,
    presentation: { deliver: (envelope: OutboundEnvelope) => connector.deliver!(envelope) },
    receiver
  };
  return {
    agentBridge,
    module,
    onConfigChanged: (next) => receiverManager.restart(next),
    sender: (next) => options.client ?? createTelegramBotClient({ config: next })
  };
}
