import {
  FEISHU_CONNECTOR_V0,
  type FeishuConfigInput,
  type FeishuConnectorConfig,
  type FeishuProjectMapping
} from "./feishuTypes.ts";
import { cleanString, firstDefined, firstString, recordValue, splitList } from "./feishuShared.ts";

const REQUIRED_SECRETS = [
  { env: "FEISHU_APP_ID", key: "appId" },
  { env: "FEISHU_APP_SECRET", key: "appSecret" },
  { env: "FEISHU_VERIFICATION_TOKEN", key: "verificationToken" }
] as const;

export function buildFeishuConnectorConfig(input: FeishuConfigInput = {}): FeishuConnectorConfig {
  const values = input as Record<string, unknown>;
  return {
    allowedChatIds: splitList(firstDefined(values.feishuAllowedChatIds, values.allowedChatIds, values.FEISHU_ALLOWED_CHAT_IDS)),
    allowedUserIds: splitList(firstDefined(values.feishuAllowedUserIds, values.allowedUserIds, values.FEISHU_ALLOWED_USER_IDS)),
    appId: firstString(values.feishuAppId, values.appId, values.FEISHU_APP_ID),
    appSecret: firstString(values.feishuAppSecret, values.appSecret, values.FEISHU_APP_SECRET),
    encryptKey: firstString(values.feishuEncryptKey, values.encryptKey, values.FEISHU_ENCRYPT_KEY),
    projectMappings: parseProjectMappings(firstDefined(values.feishuProjectMappings, values.projectMappings, values.FEISHU_PROJECT_MAPPINGS)),
    verificationToken: firstString(values.feishuVerificationToken, values.verificationToken, values.FEISHU_VERIFICATION_TOKEN)
  };
}

export function redactFeishuConnectorConfig(config: FeishuConnectorConfig): FeishuConnectorConfig {
  return {
    ...config,
    appSecret: redactSecret(config.appSecret),
    encryptKey: redactSecret(config.encryptKey),
    verificationToken: redactSecret(config.verificationToken)
  };
}

export function feishuConnectorStatus(config: FeishuConnectorConfig): Record<string, unknown> {
  const missing = missingRequired(config);
  return {
    id: "feishu",
    label: "Feishu IM",
    enabled: missing.length === 0,
    status: connectorState(config, missing),
    settings_mode: "env_or_local_uncommitted_config",
    supported_events: [...FEISHU_CONNECTOR_V0.supported_events],
    attachment_policy: FEISHU_CONNECTOR_V0.attachment_policy,
    auto_reply: FEISHU_CONNECTOR_V0.auto_reply,
    secrets: secretStatus(config),
    allowed_chat_count: config.allowedChatIds.length,
    allowed_user_count: config.allowedUserIds.length,
    project_mapping_count: config.projectMappings.length,
    missing_required: missing
  };
}

function missingRequired(config: FeishuConnectorConfig): string[] {
  return REQUIRED_SECRETS.filter((item) => cleanString(config[item.key]) === "").map((item) => item.env);
}

function connectorState(config: FeishuConnectorConfig, missing: string[]): string {
  if (missing.length === 0) return "configured";
  return hasAnyConfig(config) ? "misconfigured" : "disabled";
}

function secretStatus(config: FeishuConnectorConfig): Record<string, { configured: boolean; optional?: boolean }> {
  return {
    app_id: { configured: config.appId !== "" },
    app_secret: { configured: config.appSecret !== "" },
    verification_token: { configured: config.verificationToken !== "" },
    encrypt_key: { configured: config.encryptKey !== "", optional: true }
  };
}

function hasAnyConfig(config: FeishuConnectorConfig): boolean {
  return [config.appId, config.appSecret, config.verificationToken, config.encryptKey].some((value) => value !== "") ||
    config.allowedChatIds.length > 0 || config.allowedUserIds.length > 0 || config.projectMappings.length > 0;
}

function parseProjectMappings(value: unknown): FeishuProjectMapping[] {
  if (Array.isArray(value)) return value.map(normalizeProjectMapping).filter((item) => item !== null);
  return splitList(value).map(parseProjectMapping).filter((item) => item !== null);
}

function normalizeProjectMapping(value: unknown): FeishuProjectMapping | null {
  const item = recordValue(value);
  const projectId = cleanString(item.projectId);
  const chatId = cleanString(item.chatId);
  const userId = cleanString(item.userId);
  if (projectId === "" || (chatId === "" && userId === "")) return null;
  return { ...(chatId === "" ? {} : { chatId }), projectId, ...(userId === "" ? {} : { userId }) };
}

function parseProjectMapping(item: string): FeishuProjectMapping | null {
  const separator = item.indexOf("=");
  if (separator <= 0) return null;
  const target = item.slice(0, separator).trim();
  const projectId = item.slice(separator + 1).trim();
  if (projectId === "") return null;
  if (target.startsWith("chat:")) return { chatId: target.slice(5).trim(), projectId };
  if (target.startsWith("user:")) return { projectId, userId: target.slice(5).trim() };
  return { chatId: target, projectId };
}

function redactSecret(value: string): string {
  return value.trim() === "" ? "" : "[redacted]";
}
