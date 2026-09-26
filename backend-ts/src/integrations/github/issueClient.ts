import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubConnectorConfig } from "./config.ts";
import { createSecretService, resolveSecretLocator } from "../../security/secrets/service.ts";
import { registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import type { FetchLike } from "../git/adapterSupport.ts";

export type GitHubObject = Record<string, unknown>;
export type GitHubPage<T> = { items: T[]; next: string | null; etag: string; notModified: boolean };
export type GitHubResponse<T> = { data: T; headers: Headers; status: number };

export class GitHubIssueApiError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds = 0) {
    // 不带响应正文、完整 URL 或 Authorization，避免远端回显泄密。
    super(`GitHub issue API HTTP ${status || "transport_failure"}`);
  }
  get retryable(): boolean { return this.status === 0 || this.status === 429 || this.status >= 500 || (this.status === 403 && this.retryAfterSeconds > 0); }
}

export class GitHubIssueClient {
  private readonly api: URL;
  constructor(private readonly options: {
    apiBaseUrl: string;
    token: () => Promise<string>;
    fetch?: FetchLike;
    timeoutMs?: number;
    now?: () => number;
    signal?: AbortSignal;
  }) {
    this.api = new URL(options.apiBaseUrl.replace(/\/+$/, "") + "/");
    if (this.api.username || this.api.password || this.api.search || this.api.hash ||
      (this.api.protocol !== "https:" && !(this.api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(this.api.hostname)))) {
      throw new Error("GitHub issue API requires HTTPS (or loopback HTTP)");
    }
  }

  async request<T = GitHubObject>(path: string, input: { method?: string; body?: unknown; etag?: string } = {}): Promise<GitHubResponse<T>> {
    const url = this.checkedURL(path);
    const token = await this.options.token();
    if (!token.trim()) throw new Error("GitHub credentials are not configured");
    registerSecretForRedaction(token);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10", "user-agent": "xuanwu-issue-integration"
    };
    if (input.etag) headers["if-none-match"] = input.etag;
    if (input.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        // Bun 会把条件请求的 304 当作 redirect:error 错误；manual 保留 304，且不转发凭据。
        method: input.method ?? "GET", headers, redirect: "manual",
        signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
      });
    } catch { throw new GitHubIssueApiError(0); }
    if (response.status === 304 || response.status === 204) return { data: null as T, headers: response.headers, status: response.status };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitHubIssueApiError(response.status, retryDelay(response.headers, (this.options.now ?? Date.now)()));
    }
    try {
      const data = JSON.parse(await boundedResponseText(response, 4 * 1024 * 1024)) as T;
      return { data, headers: response.headers, status: response.status };
    } catch { throw new GitHubIssueApiError(502); }
  }

  async page<T = GitHubObject>(path: string, etag = ""): Promise<GitHubPage<T>> {
    const result = await this.request<T[]>(path, { etag });
    if (result.status === 304) return { items: [], next: null, etag: result.headers.get("etag") || etag, notModified: true };
    if (!Array.isArray(result.data)) throw new GitHubIssueApiError(502);
    const next = /<([^>]+)>;\s*rel="next"/.exec(result.headers.get("link") ?? "")?.[1] ?? null;
    if (next) this.checkedURL(next);
    return { items: result.data, next, etag: result.headers.get("etag") ?? "", notModified: false };
  }

  async all<T = GitHubObject>(path: string, maxPages = 20): Promise<T[]> {
    const output: T[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next) {
      if (visited.has(next) || visited.size >= maxPages) throw new Error("GitHub pagination limit reached; cursor must not advance");
      visited.add(next);
      const page: GitHubPage<T> = await this.page<T>(next);
      output.push(...page.items);
      next = page.next;
    }
    return output;
  }

  private checkedURL(path: string): URL {
    // 只接受 API 相对路径或同一 API 根下的分页链接；禁止带凭据的跳转。
    const url = new URL(path.replace(/^\/(?!\/)/, ""), this.api);
    if (url.origin !== this.api.origin || !url.pathname.startsWith(this.api.pathname) || url.username || url.password || url.hash) {
      throw new Error("GitHub API link is outside the configured API root");
    }
    return url;
  }
}

export function githubRepositoryPath(repository: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository) || [".", ".."].includes(repository.split("/")[1]!)) throw new Error("GitHub repository is invalid");
  return `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

export function createGitHubIssueTokenProvider(config: GitHubConnectorConfig, stateDir: string, fetchImpl?: FetchLike): () => Promise<string> {
  const auth = config.issueSync.auth;
  const secrets = createSecretService({ stateDir });
  let cached: { token: string; expires: number } | null = null;
  let pending: Promise<string> | null = null;
  const acquire = async (): Promise<string> => {
    if (auth.mode === "connector") return config.token || resolveSecretLocator(secrets, config.token_ref);
    if (auth.mode === "gh-cli") {
      try {
        const result = await promisify(execFile)("gh", ["auth", "token", "--hostname", new URL(config.web_base_url).hostname], { timeout: 10000, maxBuffer: 65536 });
        const token = result.stdout.trim();
        if (!token) throw new Error("empty token");
        cached = { token, expires: Date.now() + 60000 };
        return token;
      } catch { throw new Error("GitHub CLI authentication is unavailable"); }
    }
    const jwt = githubAppJWT(config, stateDir);
    const client = new GitHubIssueClient({ apiBaseUrl: config.api_base_url, token: async () => jwt, fetch: fetchImpl });
    const { data } = await client.request(`/app/installations/${auth.installationId}/access_tokens`, { method: "POST" });
    const token = typeof data.token === "string" ? data.token : "";
    const expires = Date.parse(String(data.expires_at)) - 60000;
    if (!token || !Number.isFinite(expires) || expires <= Date.now()) throw new Error("GitHub installation token response is invalid");
    cached = { token, expires };
    return token;
  };
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.token;
    pending ??= acquire().finally(() => { pending = null; });
    const token = await pending;
    registerSecretForRedaction(token);
    return token;
  };
}

export async function resolveGitHubWriterLogin(config: GitHubConnectorConfig, stateDir: string, client: GitHubIssueClient): Promise<string> {
  if (config.issueSync.auth.mode !== "github-app") {
    const { data } = await client.request("/user");
    if (typeof data.login !== "string" || !data.login) throw new Error("GitHub writer identity unavailable");
    return data.login;
  }
  const app = new GitHubIssueClient({ apiBaseUrl: config.api_base_url, token: async () => githubAppJWT(config, stateDir) });
  const { data } = await app.request("/app");
  if (typeof data.slug !== "string" || !/^[a-zA-Z0-9-]+$/.test(data.slug)) throw new Error("GitHub App identity unavailable");
  return `${data.slug}[bot]`;
}

function githubAppJWT(config: GitHubConnectorConfig, stateDir: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.issueSync.auth.appId })).toString("base64url");
  const key = resolveSecretLocator(createSecretService({ stateDir }), config.issueSync.auth.privateKeyRef);
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key, "base64url");
  return `${header}.${claims}.${signature}`;
}

export async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new Error("Response too large");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function retryDelay(headers: Headers, now: number): number {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const value = Number.isFinite(seconds) ? seconds : (Date.parse(retry) - now) / 1000;
    if (Number.isFinite(value)) return Math.max(1, Math.ceil(value));
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) ? Math.max(60, Math.ceil(reset - now / 1000)) : 60;
  }
  return 0;
}
