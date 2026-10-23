import { cleanString } from "../../util/values.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RemoteGitConnectorConfig = {
  api_base_url: string;
  display_name: string;
  git_base_url: string;
  provider_id: string;
  token: string;
  token_ref: string;
  web_base_url: string;
};

export type RemoteGitConnectorStatus = {
  api_base_url: string;
  auth_ref: string;
  git_base_url: string;
  provider_id: string;
  secrets: { token: { configured: boolean } };
  status: "configured" | "disabled" | "misconfigured";
  web_base_url: string;
};

export function buildRemoteGitConnectorConfig(input: {
  api_base_url: unknown;
  default_api_base_url: string;
  default_git_base_url: string;
  default_token_ref: string;
  default_web_base_url: string;
  display_name: string;
  git_base_url: unknown;
  provider_id: string;
  token: unknown;
  token_ref: unknown;
  web_base_url: unknown;
}): RemoteGitConnectorConfig {
  const tokenRef = cleanString(input.token_ref) || input.default_token_ref;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(tokenRef)) {
    throw new Error("remote Git token ref must be a secret locator, not a raw credential");
  }
  return {
    api_base_url: cleanBaseUrl(input.api_base_url, input.default_api_base_url, "API base URL"),
    display_name: requiredText(input.display_name, "provider display name", 128),
    git_base_url: cleanBaseUrl(input.git_base_url, input.default_git_base_url, "Git base URL", true),
    provider_id: requiredText(input.provider_id, "provider id", 128),
    token: cleanString(input.token),
    token_ref: tokenRef,
    web_base_url: cleanBaseUrl(input.web_base_url, input.default_web_base_url, "web base URL")
  };
}

export function remoteGitConnectorStatus(config: RemoteGitConnectorConfig): RemoteGitConnectorStatus {
  const tokenConfigured = config.token !== "";
  const refConfigured = config.token_ref !== "";
  return {
    api_base_url: config.api_base_url,
    auth_ref: config.token_ref,
    git_base_url: config.git_base_url,
    provider_id: config.provider_id,
    secrets: { token: { configured: tokenConfigured } },
    status: tokenConfigured && refConfigured ? "configured" : tokenConfigured ? "misconfigured" : "disabled",
    web_base_url: config.web_base_url
  };
}

function cleanBaseUrl(value: unknown, fallback: string, label: string, allowFile = false): string {
  const text = cleanString(value) || fallback;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!(["https:", "http:"].includes(parsed.protocol) || (allowFile && parsed.protocol === "file:"))) {
    throw new Error(`${label} must use ${allowFile ? "http, https, or file" : "http or https"}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${label} cannot contain credentials, query, or fragment`);
  return parsed.toString().replace(/\/+$/, "");
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (/\0|\r|\n/.test(text)) throw new Error(`${label} cannot contain control lines`);
  return text;
}
