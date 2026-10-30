import { delimiter } from "node:path";
import type { FeishuConfigInput } from "../integrations/feishu/feishu.ts";
import type { TelegramConfigInput } from "../integrations/telegram/telegramTypes.ts";
import { type GitHubConnectorConfigInput } from "../integrations/github/config.ts";
import { type GitLabConnectorConfigInput } from "../integrations/gitlab/config.ts";
import type { ConfigOverrides, CliConnectorConfig } from "./env.types.ts";

export function effectiveTelegramInput(overrides: ConfigOverrides): TelegramConfigInput {
  const local = overrides.integrations?.telegram ?? {};
  return {
    telegramAllowedChatIds: local.telegramAllowedChatIds ?? local.allowedChatIds ?? overrides.telegramAllowedChatIds,
    telegramAllowedUserIds: local.telegramAllowedUserIds ?? local.allowedUserIds ?? overrides.telegramAllowedUserIds,
    telegramBotToken: local.telegramBotToken ?? local.botToken ?? overrides.telegramBotToken,
    telegramBotTokenRef: local.telegramBotTokenRef ?? local.botTokenRef ?? overrides.telegramBotTokenRef,
    telegramDefaultChatId: local.telegramDefaultChatId ?? local.defaultChatId ?? overrides.telegramDefaultChatId,
    telegramEnabled: local.telegramEnabled ?? local.enabled ?? overrides.telegramEnabled,
    telegramGetMeCacheTtlSeconds: local.telegramGetMeCacheTtlSeconds ?? local.getMeCacheTtlSeconds ?? overrides.telegramGetMeCacheTtlSeconds,
    telegramPollTimeoutSeconds: local.telegramPollTimeoutSeconds ?? local.pollTimeoutSeconds ?? overrides.telegramPollTimeoutSeconds,
    telegramProjectMappings: local.telegramProjectMappings ?? local.projectMappings ?? overrides.telegramProjectMappings
  };
}

export function buildCliConnectorConfig(overrides: ConfigOverrides): CliConnectorConfig {
  const configured = overrides.cliConnectors?.manifestDirs ?? overrides.cliConnectorDirs;
  return { manifestDirs: parsePathList(configured) };
}

export function parsePathList(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(new RegExp(`[,${escapeRegExp(delimiter)}]`));
  return [...new Set(parts.map((item) => item.trim()).filter(Boolean))];
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function effectiveFeishuInput(overrides: ConfigOverrides): FeishuConfigInput {
  const local = overrides.integrations?.feishu ?? {};
  return {
    feishuAllowedChatIds: local.feishuAllowedChatIds ?? local.allowedChatIds ?? overrides.feishuAllowedChatIds,
    feishuAllowedUserIds: local.feishuAllowedUserIds ?? local.allowedUserIds ?? overrides.feishuAllowedUserIds,
    feishuAppId: local.feishuAppId ?? local.appId ?? overrides.feishuAppId,
    feishuAppSecret: local.feishuAppSecret ?? local.appSecret ?? overrides.feishuAppSecret,
    feishuDefaultChatId: local.feishuDefaultChatId ?? local.defaultChatId ?? overrides.feishuDefaultChatId,
    feishuDefaultUserId: local.feishuDefaultUserId ?? local.defaultUserId ?? overrides.feishuDefaultUserId,
    feishuEncryptKey: local.feishuEncryptKey ?? local.encryptKey ?? overrides.feishuEncryptKey,
    feishuProjectMappings: local.feishuProjectMappings ?? local.projectMappings ?? overrides.feishuProjectMappings,
    feishuReceiveMode: local.feishuReceiveMode ?? local.receiveMode ?? overrides.feishuReceiveMode,
    feishuVerificationToken: local.feishuVerificationToken ?? local.verificationToken ?? overrides.feishuVerificationToken
  };
}

export function effectiveGitHubInput(overrides: ConfigOverrides): GitHubConnectorConfigInput {
  const local = overrides.integrations?.github ?? {};
  return {
    issueSync: local.issueSync,
    apiBaseUrl: local.apiBaseUrl ?? local.GITHUB_API_URL ?? overrides.githubApiUrl,
    gitBaseUrl: local.gitBaseUrl ?? local.webBaseUrl ?? local.GITHUB_SERVER_URL ?? overrides.githubServerUrl,
    graphqlBaseUrl: local.graphqlBaseUrl ?? local.GITHUB_GRAPHQL_URL ?? overrides.githubGraphqlUrl,
    token: local.token ?? local.GITHUB_TOKEN ?? overrides.githubToken,
    tokenRef: local.tokenRef ?? local.GITHUB_TOKEN_REF ?? overrides.githubTokenRef,
    webBaseUrl: local.webBaseUrl ?? local.GITHUB_SERVER_URL ?? overrides.githubServerUrl
  };
}

export function effectiveGitLabInput(overrides: ConfigOverrides): GitLabConnectorConfigInput {
  const local = overrides.integrations?.gitlab ?? {};
  return {
    apiBaseUrl: local.apiBaseUrl ?? local.GITLAB_API_URL ?? overrides.gitlabApiUrl,
    gitBaseUrl: local.gitBaseUrl ?? local.webBaseUrl ?? local.GITLAB_SERVER_URL ?? overrides.gitlabServerUrl,
    token: local.token ?? local.GITLAB_TOKEN ?? overrides.gitlabToken,
    tokenRef: local.tokenRef ?? local.GITLAB_TOKEN_REF ?? overrides.gitlabTokenRef,
    webBaseUrl: local.webBaseUrl ?? local.GITLAB_SERVER_URL ?? overrides.gitlabServerUrl
  };
}
