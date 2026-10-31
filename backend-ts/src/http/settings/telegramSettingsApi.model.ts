import type { RunnerConfig } from "../../config/env.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { type TelegramBotClient } from "../../integrations/telegram/telegramClient.ts";
import type { TelegramConnectorConfig } from "../../integrations/telegram/telegramTypes.ts";
import { type SecretService } from "../../security/secrets/service.ts";

export type Context = {
  config?: RunnerConfig;
  database: RunnerDatabase;
  onConfigChanged?: (config: TelegramConnectorConfig) => Promise<void> | void;
  secrets?: SecretService;
  telegramClientFactory?: (config: TelegramConnectorConfig) => TelegramBotClient;
};

export type TelegramSourceCandidate = {
  chat_id: string;
  chat_title: string;
  chat_type: string;
  observed_at: string;
  user_display_name: string;
  user_id: string;
  user_username: string;
};

export type LocalSettings = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  botToken: string;
  botTokenRef: string;
  defaultChatId: string;
  enabled: boolean;
  getMeCacheTtlSeconds: number;
  pollTimeoutSeconds: number;
  projectMappings: string;
};
