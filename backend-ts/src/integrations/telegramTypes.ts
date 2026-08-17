export type TelegramProjectMapping = { chatId?: string; projectId: string; userId?: string };

export type TelegramConnectorConfig = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  botToken: string;
  botTokenRef: string;
  defaultChatId: string;
  enabled: boolean;
  getMeCacheTtlSeconds: number;
  pollTimeoutSeconds: number;
  projectMappings: TelegramProjectMapping[];
  receiveMode: "long_polling";
};

export type TelegramConnectorOverrides = {
  telegramAllowedChatIds?: string | string[];
  telegramAllowedUserIds?: string | string[];
  telegramBotToken?: string;
  telegramBotTokenRef?: string;
  telegramDefaultChatId?: string;
  telegramEnabled?: boolean | string;
  telegramGetMeCacheTtlSeconds?: number | string;
  telegramPollTimeoutSeconds?: number | string;
  telegramProjectMappings?: string | TelegramProjectMapping[];
};

export type TelegramEnvInput = {
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN_REF?: string;
  TELEGRAM_DEFAULT_CHAT_ID?: string;
  TELEGRAM_ENABLED?: string;
  TELEGRAM_GET_ME_CACHE_TTL_SECONDS?: string;
  TELEGRAM_POLL_TIMEOUT_SECONDS?: string;
  TELEGRAM_PROJECT_MAPPINGS?: string;
};

export type TelegramConfigInput = Partial<TelegramConnectorConfig> & TelegramConnectorOverrides & TelegramEnvInput;

export type TelegramUser = {
  first_name?: string;
  id: number | string;
  is_bot: boolean;
  last_name?: string;
  username?: string;
};

export type TelegramChat = {
  id: number | string;
  title?: string;
  type: "channel" | "group" | "private" | "supergroup" | string;
  username?: string;
};

export type TelegramMessageEntity = {
  length: number;
  offset: number;
  type: string;
  user?: TelegramUser;
};

export type TelegramFile = {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
};

export type TelegramMessage = {
  audio?: TelegramFile;
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  chat: TelegramChat;
  date: number;
  document?: TelegramFile;
  entities?: TelegramMessageEntity[];
  from?: TelegramUser;
  message_id: number;
  message_thread_id?: number;
  photo?: Array<{ file_id: string; file_size?: number; height?: number; width?: number }>;
  reply_to_message?: Pick<TelegramMessage, "message_id">;
  sender_chat?: TelegramChat;
  text?: string;
  video?: TelegramFile;
};

export type TelegramCallbackQuery = {
  data?: string;
  from: TelegramUser;
  id: string;
  inline_message_id?: string;
  message?: TelegramMessage;
};

export type TelegramUpdate = {
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
  message?: TelegramMessage;
  update_id: number;
};

export type TelegramBotIdentity = TelegramUser & {
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
};
