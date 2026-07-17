import { dirname } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import { localSettingsPath, readLocalSettingsFile, updateLocalSettingsFile } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import {
  buildFeishuConnectorConfig,
  feishuConnectorStatus,
  type FeishuConnectorConfig,
  type FeishuProjectMapping,
  type FeishuReceiveMode
} from "../integrations/feishu.ts";
import { cleanString, splitList } from "../integrations/feishuShared.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { createDatabaseSecretService, type SecretService } from "../security/secrets/service.ts";

type FeishuSettingsContext = {
  config?: RunnerConfig;
  database: RunnerDatabase;
  onConfigChanged?: (config: FeishuConnectorConfig) => Promise<void> | void;
  secrets?: SecretService;
};
type LocalFeishuSettings = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  appId: string;
  appSecret: string;
  defaultChatId: string;
  defaultUserId: string;
  encryptKey: string;
  projectMappings: string;
  receiveMode: FeishuReceiveMode;
  verificationToken: string;
};

export function registerFeishuSettingsRoutes(router: Router, context: FeishuSettingsContext): void {
  const activeContext = { ...context, secrets: context.secrets ?? createDatabaseSecretService(context.database) };
  router.get("/api/integrations/feishu/settings", () => json(publicFeishuSettings(currentConfig(activeContext), settingsPath(activeContext))));
  router.put("/api/integrations/feishu/settings", async (request) => {
    return json(await saveFeishuSettings(activeContext, await objectBody(request)));
  });
}

async function saveFeishuSettings(context: FeishuSettingsContext, body: Record<string, unknown>) {
  const path = settingsPath(context);
  const current = localSettingsFromConfig(currentConfig(context));
  const nextLocal = normalizeFeishuSettings(body, current);
  const persisted = await persistedFeishuSettings(path, nextLocal, body, context.secrets!);
  await updateLocalSettingsFile(path, (settings) => ({
    ...settings,
    integrations: { ...settings.integrations, feishu: persisted }
  }));
  const nextConfig = buildFeishuConnectorConfig(nextLocal);
  applyRuntimeFeishuConfig(context.config, nextConfig);
  recordFeishuSettingsAudit(context.database, body, nextConfig);
  await context.onConfigChanged?.(nextConfig);
  return publicFeishuSettings(nextConfig, path);
}

async function persistedFeishuSettings(
  path: string,
  next: LocalFeishuSettings,
  body: Record<string, unknown>,
  secrets: SecretService
): Promise<Record<string, unknown>> {
  const existing = (await readLocalSettingsFile(path)).integrations?.feishu ?? {};
  const stored: Record<string, unknown> = {
    allowedChatIds: next.allowedChatIds,
    allowedUserIds: next.allowedUserIds,
    appId: next.appId,
    defaultChatId: next.defaultChatId,
    defaultUserId: next.defaultUserId,
    projectMappings: next.projectMappings,
    receiveMode: next.receiveMode
  };
  persistSecretField(stored, existing, body, secrets, "app_secret", "appSecret", "appSecretRef", "integrations/feishu/app-secret");
  persistSecretField(stored, existing, body, secrets, "encrypt_key", "encryptKey", "encryptKeyRef", "integrations/feishu/encrypt-key");
  persistSecretField(stored, existing, body, secrets, "verification_token", "verificationToken", "verificationTokenRef", "integrations/feishu/verification-token");
  return stored;
}

function persistSecretField(
  output: Record<string, unknown>,
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  secrets: SecretService,
  bodyKey: string,
  legacyKey: string,
  refKey: string,
  name: string
): void {
  const submitted = hasOwn(body, bodyKey) ? cleanString(body[bodyKey]) : "";
  if (submitted !== "") {
    output[refKey] = secrets.putOrRotate(name, submitted, "user", `updated Feishu ${bodyKey}`).ref;
    return;
  }
  const existingRef = cleanString(existing[refKey]);
  if (existingRef !== "") output[refKey] = existingRef;
  else {
    const legacy = cleanString(existing[legacyKey]);
    if (legacy !== "") output[legacyKey] = legacy;
  }
}

function recordFeishuSettingsAudit(database: RunnerDatabase, body: Record<string, unknown>, config: FeishuConnectorConfig): void {
  createPiActionEvent(database, {
    action_id: `feishu-settings:${crypto.randomUUID()}`,
    actor: "user",
    event_type: "connector_settings_updated",
    payload_json: JSON.stringify({
      connector_id: "feishu",
      credential_fields_changed: ["app_secret", "encrypt_key", "verification_token"].filter((key) => cleanString(body[key]) !== ""),
      receive_mode: config.receiveMode
    }),
    reason: "updated Feishu connector settings",
    result_json: JSON.stringify({ status: "succeeded" })
  });
}

function publicFeishuSettings(config: FeishuConnectorConfig, path: string): Record<string, unknown> {
  const status = feishuConnectorStatus(config);
  return {
    allowed_chat_ids: config.allowedChatIds,
    allowed_user_ids: config.allowedUserIds,
    app_id: config.appId,
    app_secret_configured: config.appSecret !== "",
    callback_path: "/api/integrations/feishu/events",
    default_chat_id: config.defaultChatId,
    default_user_id: config.defaultUserId,
    enabled: status.enabled,
    encrypt_key_configured: config.encryptKey !== "",
    missing_required: status.missing_required,
    project_mappings: formatProjectMappings(config.projectMappings),
    public_url_required: config.receiveMode === "callback",
    receive_mode: config.receiveMode,
    settings_file: path,
    status: status.status,
    verification_token_configured: config.verificationToken !== ""
  };
}

function normalizeFeishuSettings(body: Record<string, unknown>, current: LocalFeishuSettings): LocalFeishuSettings {
  return {
    allowedChatIds: listField(body, "allowed_chat_ids", current.allowedChatIds),
    allowedUserIds: listField(body, "allowed_user_ids", current.allowedUserIds),
    appId: stringField(body, "app_id", current.appId),
    appSecret: secretField(body, "app_secret", current.appSecret),
    defaultChatId: stringField(body, "default_chat_id", current.defaultChatId),
    defaultUserId: stringField(body, "default_user_id", current.defaultUserId),
    encryptKey: secretField(body, "encrypt_key", current.encryptKey),
    projectMappings: stringField(body, "project_mappings", current.projectMappings),
    receiveMode: receiveModeField(body, current.receiveMode),
    verificationToken: secretField(body, "verification_token", current.verificationToken)
  };
}

function localSettingsFromConfig(config: FeishuConnectorConfig): LocalFeishuSettings {
  return {
    allowedChatIds: config.allowedChatIds,
    allowedUserIds: config.allowedUserIds,
    appId: config.appId,
    appSecret: config.appSecret,
    defaultChatId: config.defaultChatId,
    defaultUserId: config.defaultUserId,
    encryptKey: config.encryptKey,
    projectMappings: formatProjectMappings(config.projectMappings),
    receiveMode: config.receiveMode,
    verificationToken: config.verificationToken
  };
}

function applyRuntimeFeishuConfig(config: RunnerConfig | undefined, next: FeishuConnectorConfig): void {
  if (!config) return;
  Object.assign(config.integrations.feishu, next);
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function settingsPath(context: FeishuSettingsContext): string {
  return localSettingsPath(context.config?.stateDir || dirname(context.database.path));
}

function currentConfig(context: FeishuSettingsContext): FeishuConnectorConfig {
  return context.config?.integrations.feishu ?? buildFeishuConnectorConfig();
}

function listField(body: Record<string, unknown>, key: string, current: string[]): string[] {
  return hasOwn(body, key) ? splitList(body[key]) : current;
}

function stringField(body: Record<string, unknown>, key: string, current: string): string {
  return hasOwn(body, key) ? cleanString(body[key]) : current;
}

function receiveModeField(body: Record<string, unknown>, current: FeishuReceiveMode): FeishuReceiveMode {
  const value = stringField(body, "receive_mode", current);
  return value === "callback" ? "callback" : "websocket";
}

function secretField(body: Record<string, unknown>, key: string, current: string): string {
  const value = hasOwn(body, key) ? cleanString(body[key]) : "";
  return value === "" ? current : value;
}

function formatProjectMappings(mappings: FeishuProjectMapping[]): string {
  return mappings.map((item) => `${mappingTarget(item)}=${item.projectId}`).join(",");
}

function mappingTarget(item: FeishuProjectMapping): string {
  if (item.chatId) return `chat:${item.chatId}`;
  if (item.userId) return `user:${item.userId}`;
  return "";
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
