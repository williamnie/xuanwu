import {
  buildRemoteGitConnectorConfig,
  redactRemoteGitConnectorConfig,
  remoteGitConnectorStatus,
  type RemoteGitConnectorConfig,
  type RemoteGitConnectorStatus
} from "../git/adapterSupport.ts";

export type GitLabConnectorConfig = RemoteGitConnectorConfig;

export type GitLabConnectorConfigInput = Partial<{
  apiBaseUrl: string;
  gitBaseUrl: string;
  token: string;
  tokenRef: string;
  webBaseUrl: string;
  GITLAB_API_URL: string;
  GITLAB_SERVER_URL: string;
  GITLAB_TOKEN: string;
  GITLAB_TOKEN_REF: string;
}>;

export function buildGitLabConnectorConfig(input: GitLabConnectorConfigInput = {}): GitLabConnectorConfig {
  const serverURL = input.webBaseUrl ?? input.GITLAB_SERVER_URL;
  const defaultServerURL = serverURL?.trim().replace(/\/+$/, "") || "https://gitlab.com";
  return buildRemoteGitConnectorConfig({
    api_base_url: input.apiBaseUrl ?? input.GITLAB_API_URL,
    default_api_base_url: `${defaultServerURL}/api/v4`,
    default_git_base_url: defaultServerURL,
    default_token_ref: "env://GITLAB_TOKEN",
    default_web_base_url: "https://gitlab.com",
    display_name: "GitLab",
    git_base_url: input.gitBaseUrl ?? serverURL,
    provider_id: "gitlab",
    token: input.token ?? input.GITLAB_TOKEN,
    token_ref: input.tokenRef ?? input.GITLAB_TOKEN_REF,
    web_base_url: serverURL
  });
}

export function gitlabConnectorStatus(config: GitLabConnectorConfig): RemoteGitConnectorStatus {
  return remoteGitConnectorStatus(config);
}

export function redactGitLabConnectorConfig(config: GitLabConnectorConfig): GitLabConnectorConfig {
  return redactRemoteGitConnectorConfig(config);
}
