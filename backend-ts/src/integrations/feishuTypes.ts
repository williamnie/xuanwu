import type { ExternalEventInput } from "../db/repositories/externalEvents.ts";

export const FEISHU_CONNECTOR_V0 = {
  auto_reply: false,
  callback_requirements: {
    challenge: "required",
    encryption: "supported_optional",
    signature: "required"
  },
  supported_events: ["message.text", "message.mention"],
  attachment_policy: "metadata_only"
} as const;

export type FeishuProjectMapping = { chatId?: string; projectId: string; userId?: string };
export type FeishuReceiveMode = "websocket" | "callback";

export type FeishuConnectorConfig = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  appId: string;
  appSecret: string;
  defaultChatId: string;
  defaultUserId: string;
  encryptKey: string;
  projectMappings: FeishuProjectMapping[];
  receiveMode: FeishuReceiveMode;
  verificationToken: string;
};

export type FeishuConnectorOverrides = {
  feishuAllowedChatIds?: string | string[];
  feishuAllowedUserIds?: string | string[];
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDefaultChatId?: string;
  feishuDefaultUserId?: string;
  feishuEncryptKey?: string;
  feishuProjectMappings?: string | FeishuProjectMapping[];
  feishuReceiveMode?: string;
  feishuVerificationToken?: string;
};

export type FeishuEnvInput = {
  FEISHU_ALLOWED_CHAT_IDS?: string;
  FEISHU_ALLOWED_USER_IDS?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_DEFAULT_CHAT_ID?: string;
  FEISHU_DEFAULT_USER_ID?: string;
  FEISHU_ENCRYPT_KEY?: string;
  FEISHU_PROJECT_MAPPINGS?: string;
  FEISHU_RECEIVE_MODE?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
};

export type FeishuConfigInput = Omit<Partial<FeishuConnectorConfig>, "projectMappings"> & { projectMappings?: string | FeishuProjectMapping[] } & FeishuConnectorOverrides & FeishuEnvInput;

export type FeishuAttachment = { file_key: string; mime_type: string; name: string; size: number; type: string };
export type FeishuMention = { id: string; name: string; tenant_key: string };
export type FeishuSender = { id: string; open_id: string; tenant_key: string; type: string };

export type FeishuNormalizedMessageEvent = {
  attachments: FeishuAttachment[];
  chat_id: string;
  chat_type: string;
  dedupe_key: string;
  mentions: FeishuMention[];
  message_id: string;
  raw_event_ref: string;
  root_id: string;
  sender: FeishuSender;
  source_id: string;
  text: string;
  thread_id: string;
  timestamp: string;
};

export type FeishuExternalEventInput = ExternalEventInput;
