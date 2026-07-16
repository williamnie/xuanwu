import {
  buildRemoteGitConnectorConfig,
  redactRemoteGitConnectorConfig,
  remoteGitConnectorStatus,
  type RemoteGitConnectorConfig,
  type RemoteGitConnectorStatus
} from "../git/adapterSupport.ts";

export type GitHubConnectorConfig = RemoteGitConnectorConfig & { graphql_base_url: string };

export type GitHubConnectorConfigInput = Partial<{
  apiBaseUrl: string;
  gitBaseUrl: string;
  graphqlBaseUrl: string;
  token: string;
  tokenRef: string;
  webBaseUrl: string;
  GITHUB_API_URL: string;
  GITHUB_GRAPHQL_URL: string;
  GITHUB_SERVER_URL: string;
  GITHUB_TOKEN: string;
  GITHUB_TOKEN_REF: string;
}>;

export function buildGitHubConnectorConfig(input: GitHubConnectorConfigInput = {}): GitHubConnectorConfig {
  const serverURL = input.webBaseUrl ?? input.GITHUB_SERVER_URL;
  const defaultServerURL = cleanServerURL(serverURL) || "https://github.com";
  const base = buildRemoteGitConnectorConfig({
    api_base_url: input.apiBaseUrl ?? input.GITHUB_API_URL,
    default_api_base_url: defaultServerURL === "https://github.com" ? "https://api.github.com" : `${defaultServerURL}/api/v3`,
    default_git_base_url: defaultServerURL,
    default_token_ref: "env://GITHUB_TOKEN",
    default_web_base_url: "https://github.com",
    display_name: "GitHub",
    git_base_url: input.gitBaseUrl ?? serverURL,
    provider_id: "github",
    token: input.token ?? input.GITHUB_TOKEN,
    token_ref: input.tokenRef ?? input.GITHUB_TOKEN_REF,
    web_base_url: serverURL
  });
  return {
    ...base,
    graphql_base_url: cleanGraphqlURL(input.graphqlBaseUrl ?? input.GITHUB_GRAPHQL_URL, base.api_base_url)
  };
}

function cleanServerURL(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function githubConnectorStatus(config: GitHubConnectorConfig): RemoteGitConnectorStatus & { graphql_base_url: string } {
  return { ...remoteGitConnectorStatus(config), graphql_base_url: config.graphql_base_url };
}

export function redactGitHubConnectorConfig(config: GitHubConnectorConfig): GitHubConnectorConfig {
  return { ...redactRemoteGitConnectorConfig(config), graphql_base_url: config.graphql_base_url };
}

function cleanGraphqlURL(value: string | undefined, apiBaseURL: string): string {
  const fallback = apiBaseURL === "https://api.github.com"
    ? "https://api.github.com/graphql"
    : apiBaseURL.replace(/\/api\/v3$/, "/api/graphql") + (apiBaseURL.endsWith("/api/v3") ? "" : "/graphql");
  const text = value?.trim() || fallback;
  const parsed = new URL(text);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("GitHub GraphQL URL must use http or https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GitHub GraphQL URL cannot contain credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/+$/, "");
}
