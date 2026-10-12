export type PiOAuthPhase = "initializing_runtime" | "provider_login" | "token_exchange" | "credential_storage" | "runtime_sync" | "complete";
export type PiOAuthFailureDiagnostic = {
  phase: PiOAuthPhase;
  category: "provider_http" | "network" | "credential_storage" | "runtime_sync" | "invalid_token_response" | "callback" | "unknown";
  http_status?: number;
  provider_code?: string;
  system_code?: string;
};

const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"
]);
const STORAGE_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOENT", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE"]);
const PROVIDER_CODES = new Set([
  "invalid_grant", "invalid_request", "invalid_client", "invalid_scope", "access_denied", "unauthorized_client",
  "server_error", "temporarily_unavailable", "token_revoked", "unsupported_country_region_territory"
]);

// OAuth 异常可能附带完整 token 响应、授权 URL 或 credential 对象；只输出白名单诊断字段。
export function diagnosePiOAuthFailure(error: unknown, phase: PiOAuthPhase): PiOAuthFailureDiagnostic {
  const chain = errorChain(error);
  const messages = chain.map(item => typeof item === "string" ? item.slice(0, 16_384) : field(item, "message").slice(0, 16_384));
  const code = chain.map(item => field(item, "code")).find(value => NETWORK_CODES.has(value) || STORAGE_CODES.has(value) || value === "EADDRINUSE");
  const fields = code ? { system_code: code } : {};
  if (messages.some(message => message.startsWith("Credential login committed for openai-codex, but local synchronization failed"))) {
    return { phase: "runtime_sync", category: "runtime_sync", ...fields };
  }
  if (phase === "credential_storage" || messages.some(message => message.startsWith("Credential store modify failed for openai-codex"))) {
    return { phase: "credential_storage", category: "credential_storage", ...fields };
  }
  for (const message of messages) {
    const match = /^OpenAI Codex token exchange failed \(([1-5]\d{2})\):\s*([\s\S]*)/.exec(message);
    if (!match) continue;
    const providerCode = providerErrorCode(match[2]);
    return { phase: "token_exchange", category: "provider_http", http_status: Number(match[1]), ...(providerCode ? { provider_code: providerCode } : {}) };
  }
  if (messages.some(message => message.startsWith("OpenAI Codex token exchange response missing fields:") || message === "Failed to extract accountId from token")) {
    return { phase: "token_exchange", category: "invalid_token_response" };
  }
  if (code === "EADDRINUSE" || messages.some(message => message === "State mismatch" || message === "Missing authorization code")) {
    return { phase, category: "callback", ...fields };
  }
  if ((code && NETWORK_CODES.has(code)) || messages.some(message => /^(fetch failed|Failed to fetch|Unable to connect\.|The socket connection was closed|Failed to open socket)/i.test(message))) {
    return { phase, category: "network", ...fields };
  }
  return { phase, category: code && STORAGE_CODES.has(code) ? "credential_storage" : "unknown", ...fields };
}

function errorChain(error: unknown): unknown[] {
  const result: unknown[] = [];
  let current = error;
  while (current && result.length < 8 && !result.includes(current)) {
    result.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return result;
}

function field(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : "";
}

function providerErrorCode(body: string): string | undefined {
  try {
    const data = JSON.parse(body);
    const code = typeof data.error === "string" ? data.error : data.error?.code;
    return typeof code === "string" && PROVIDER_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
