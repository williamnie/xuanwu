import { dirname } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import { localSettingsPath, updateLocalSettingsFile } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import {
  buildFeishuConnectorConfig,
  feishuConnectorStatus,
  type FeishuConnectorConfig,
  type FeishuProjectMapping
} from "../integrations/feishu.ts";
import { cleanString, splitList } from "../integrations/feishuShared.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type FeishuSettingsContext = { config?: RunnerConfig; database: RunnerDatabase };
type LocalFeishuSettings = {
  allowedChatIds: string[];
  allowedUserIds: string[];
  appId: string;
  appSecret: string;
  encryptKey: string;
  projectMappings: string;
  verificationToken: string;
};

export function registerFeishuSettingsRoutes(router: Router, context: FeishuSettingsContext): void {
  router.get("/api/integrations/feishu/settings", () => json(publicFeishuSettings(currentConfig(context), settingsPath(context))));
  router.put("/api/integrations/feishu/settings", async (request) => {
    return json(await saveFeishuSettings(context, await objectBody(request)));
  });
}

async function saveFeishuSettings(context: FeishuSettingsContext, body: Record<string, unknown>) {
  const path = settingsPath(context);
  const current = localSettingsFromConfig(currentConfig(context));
  const nextLocal = normalizeFeishuSettings(body, current);
  await updateLocalSettingsFile(path, (settings) => ({
    ...settings,
    integrations: { ...settings.integrations, feishu: nextLocal }
  }));
  const nextConfig = buildFeishuConnectorConfig(nextLocal);
  applyRuntimeFeishuConfig(context.config, nextConfig);
  return publicFeishuSettings(nextConfig, path);
}

function publicFeishuSettings(config: FeishuConnectorConfig, path: string): Record<string, unknown> {
  const status = feishuConnectorStatus(config);
  return {
    allowed_chat_ids: config.allowedChatIds,
    allowed_user_ids: config.allowedUserIds,
    app_id: config.appId,
    app_secret_configured: config.appSecret !== "",
    callback_path: "/api/integrations/feishu/events",
    enabled: status.enabled,
    encrypt_key_configured: config.encryptKey !== "",
    missing_required: status.missing_required,
    project_mappings: formatProjectMappings(config.projectMappings),
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
    encryptKey: secretField(body, "encrypt_key", current.encryptKey),
    projectMappings: stringField(body, "project_mappings", current.projectMappings),
    verificationToken: secretField(body, "verification_token", current.verificationToken)
  };
}

function localSettingsFromConfig(config: FeishuConnectorConfig): LocalFeishuSettings {
  return {
    allowedChatIds: config.allowedChatIds,
    allowedUserIds: config.allowedUserIds,
    appId: config.appId,
    appSecret: config.appSecret,
    encryptKey: config.encryptKey,
    projectMappings: formatProjectMappings(config.projectMappings),
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
