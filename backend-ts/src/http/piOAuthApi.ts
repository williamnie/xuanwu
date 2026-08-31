import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthAuthInfo, OAuthCredentials, OAuthPrompt } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";
import { updatePiCredential } from "./piCredentialFile.ts";

export type PiOAuthLoginCallbacks = {
  onAuth: (info: OAuthAuthInfo) => void;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};
export type PiOpenAICodexOAuthLogin = (
  callbacks: PiOAuthLoginCallbacks,
  signal?: AbortSignal
) => Promise<OAuthCredentials>;
export type PiOpenAICodexModelDiscovery = (database: RunnerDatabase, signal?: AbortSignal) => Promise<string[]>;
type PiOAuthContext = {
  database: RunnerDatabase;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  piOAuthLoginTimeoutMs?: number;
};
type LoginAbortReason = "logout" | "restarted" | "timeout";
type LoginState = {
  abortController: AbortController;
  abortReason?: LoginAbortReason;
  authUrl?: string;
  completion?: Promise<void>;
  error?: string;
  instructions?: string;
  message?: string;
  startedAt: string;
  status: "pending" | "authenticated" | "error";
  timeout?: ReturnType<typeof setTimeout>;
};

const OPENAI_CODEX_PROVIDER = "openai-codex";
const RUNNER_OAUTH_ORIGINATOR = "pi-agent";
const DEFAULT_OAUTH_LOGIN_TIMEOUT_MS = 10 * 60_000;
const loginStates = new Map<string, LoginState>();

export function registerPiOAuthRoutes(router: Router, context: PiOAuthContext): void {
  router.get("/api/pi/oauth/openai-codex/status", async () => json(await oauthStatus(context.database)));
  router.post("/api/pi/oauth/openai-codex/login", async () => json(await startOpenAICodexLogin(context)));
  router.post("/api/pi/oauth/openai-codex/logout", async () => json(await logoutOpenAICodex(context.database)));
}

async function startOpenAICodexLogin(context: PiOAuthContext) {
  const authPath = piAuthPath(context.database);
  const existing = loginStates.get(authPath);
  if (existing?.status === "pending") await cancelPendingLogin(existing, "restarted");
  const state = pendingState(context.piOAuthLoginTimeoutMs ?? DEFAULT_OAUTH_LOGIN_TIMEOUT_MS);
  loginStates.set(authPath, state);
  try {
    await beginLogin(context, state);
  } catch {
    throw new HttpError(502, state.message || "Codex OAuth 登录初始化失败，请重试");
  }
  recordOAuthAudit(context.database, "provider_oauth_login_started", "pending");
  return await loginResponse(context.database, state);
}

function beginLogin(context: PiOAuthContext, state: LoginState): Promise<OAuthAuthInfo> {
  let resolveAuth: (info: OAuthAuthInfo) => void = () => {};
  let rejectAuth: (error: unknown) => void = () => {};
  const authInfo = new Promise<OAuthAuthInfo>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  const injectedLogin = context.piOpenAICodexOAuthLogin;
  const login = injectedLogin ?? ((callbacks: PiOAuthLoginCallbacks, signal?: AbortSignal) => (
    defaultOpenAICodexLogin(context.database, callbacks, signal)
  ));
  state.completion = login({
    onAuth: (info) => {
      const normalized = withRunnerOAuthOriginator(info);
      state.authUrl = normalized.url;
      state.instructions = normalized.instructions;
      resolveAuth(normalized);
    },
    onPrompt: async () => { throw new Error("Manual OAuth code paste is not supported from Runner Settings yet."); }
  }, state.abortController.signal).then((credentials) => completeLogin(
    context.database,
    credentials,
    state,
    injectedLogin !== undefined
  ))
    .catch((error) => {
      markLoginFailed(context.database, state, error);
      rejectAuth(error);
    })
    .finally(() => clearLoginTimeout(state));
  return authInfo;
}

async function defaultOpenAICodexLogin(
  db: RunnerDatabase,
  callbacks: PiOAuthLoginCallbacks,
  signal?: AbortSignal
): Promise<OAuthCredentials> {
  const runtime = await createPiModelRuntime(db, signal);
  const credential = await runtime.login(OPENAI_CODEX_PROVIDER, "oauth", {
    signal,
    notify: (event) => {
      if (event.type === "auth_url") callbacks.onAuth({ url: event.url, instructions: event.instructions });
      if (event.type === "progress") callbacks.onProgress?.(event.message);
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") return "browser";
      if (prompt.type === "manual_code") return await waitForPromptCancellation(prompt.signal);
      return await callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
    }
  });
  if (credential.type !== "oauth") throw new Error("OpenAI Codex OAuth returned a non-OAuth credential");
  return credential;
}

function waitForPromptCancellation(signal: AbortSignal | undefined): Promise<string> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function completeLogin(
  db: RunnerDatabase,
  credentials: OAuthCredentials,
  state: LoginState,
  persistInjectedCredential: boolean
): Promise<void> {
  if (state.abortController.signal.aborted || loginStates.get(piAuthPath(db)) !== state) return;
  if (persistInjectedCredential) {
    await updatePiCredential(piAuthPath(db), OPENAI_CODEX_PROVIDER, { type: "oauth", ...credentials });
  }
  state.status = "authenticated";
  state.authUrl = undefined;
  state.instructions = undefined;
  state.error = undefined;
  state.message = "Codex OAuth 登录成功";
  recordOAuthAudit(db, "provider_oauth_configured", "succeeded");
}

function markLoginFailed(db: RunnerDatabase, state: LoginState, error: unknown): void {
  if (state.status === "authenticated") return;
  state.status = "error";
  const failure = publicLoginFailure(state, error);
  state.error = failure.code;
  state.message = failure.message;
  recordOAuthAudit(
    db,
    state.abortReason === "restarted" || state.abortReason === "logout"
      ? "provider_oauth_cancelled"
      : "provider_oauth_failed",
    state.abortReason === "restarted" || state.abortReason === "logout" ? "cancelled" : "failed",
    failure.code
  );
}

export async function removePiOpenAICodexOAuthCredential(db: RunnerDatabase): Promise<boolean> {
  const authPath = piAuthPath(db);
  const state = loginStates.get(authPath);
  if (state?.status === "pending") await cancelPendingLogin(state, "logout");
  loginStates.delete(authPath);
  const configured = await hasStoredPiCredential(piAuthPath(db));
  if (configured) {
    const runtime = await createPiModelRuntime(db);
    await runtime.logout(OPENAI_CODEX_PROVIDER);
  }
  if (configured) recordOAuthAudit(db, "provider_oauth_logged_out", "succeeded");
  return configured;
}

async function logoutOpenAICodex(db: RunnerDatabase) {
  await removePiOpenAICodexOAuthCredential(db);
  return await oauthStatus(db);
}

export async function isPiOpenAICodexOAuthConfigured(db: RunnerDatabase): Promise<boolean> {
  return await hasStoredPiCredential(piAuthPath(db));
}

export async function discoverPiOpenAICodexModels(
  db: RunnerDatabase,
  signal?: AbortSignal
): Promise<string[]> {
  const runtime = await createPiModelRuntime(db, signal);
  const result = await runtime.refresh({
    allowNetwork: true,
    force: true,
    providers: [OPENAI_CODEX_PROVIDER],
    signal
  });
  if (result.aborted) throw signal?.reason ?? new Error("Codex model discovery was aborted");
  const refreshError = result.errors.get(OPENAI_CODEX_PROVIDER);
  if (refreshError) throw refreshError;
  const models = await runtime.getAvailable(OPENAI_CODEX_PROVIDER, { signal });
  return [...new Set(models.map((model) => model.id).filter(Boolean))];
}

async function oauthStatus(db: RunnerDatabase) {
  const authPath = piAuthPath(db);
  const configured = await hasStoredPiCredential(authPath);
  const state = loginStates.get(authPath);
  const base = {
    provider: OPENAI_CODEX_PROVIDER,
    pi_oauth: { configured, source: configured ? "stored" : "none", status: state?.status ?? "idle" },
    codex_login: codexLoginStatus()
  };
  if (!state) return base;
  return {
    ...base,
    auth_url: state.authUrl ?? "",
    error: state.error ?? "",
    instructions: state.instructions ?? "",
    message: state.message ?? "",
    started_at: state.startedAt,
    status: state.status
  };
}

async function hasStoredPiCredential(authPath: string): Promise<boolean> {
  const { readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  return readStoredCredential(OPENAI_CODEX_PROVIDER, authPath) !== undefined;
}

async function loginResponse(db: RunnerDatabase, state: LoginState) {
  return {
    ...await oauthStatus(db),
    auth_url: state.authUrl ?? "",
    instructions: state.instructions ?? "",
    status: state.status
  };
}

function codexLoginStatus() {
  const path = join(codexHome(), "auth.json");
  if (!existsSync(path)) return { configured: false, path, storage: "file" };
  return codexAuthFromFile(path);
}

function codexAuthFromFile(path: string) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { auth_mode: cleanString(raw.auth_mode), configured: hasCodexCredential(raw), path, storage: "file" };
  } catch {
    return { configured: false, error: "invalid_auth_json", path, storage: "file" };
  }
}

function hasCodexCredential(raw: Record<string, unknown>): boolean {
  const tokens = isObject(raw.tokens) ? raw.tokens : {};
  return cleanString(tokens.access_token) !== "" || cleanString(raw.OPENAI_API_KEY) !== "";
}

function pendingState(timeoutMs: number): LoginState {
  const state: LoginState = {
    abortController: new AbortController(),
    startedAt: new Date().toISOString(),
    status: "pending"
  };
  state.timeout = setTimeout(() => {
    if (state.status !== "pending") return;
    state.abortReason = "timeout";
    state.abortController.abort(new Error("oauth_login_timeout"));
  }, Math.max(1, timeoutMs));
  return state;
}

function piAuthPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "auth.json");
}

function piModelsPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "models.json");
}

async function createPiModelRuntime(db: RunnerDatabase, signal?: AbortSignal) {
  const [{ registerBunOAuthFlows }, { ModelRuntime }] = await Promise.all([
    import("@earendil-works/pi-ai/bun-oauth"),
    import("@earendil-works/pi-coding-agent")
  ]);
  registerBunOAuthFlows();
  return await ModelRuntime.create({
    authPath: piAuthPath(db),
    modelsPath: piModelsPath(db),
    refreshOnCreate: false,
    signal
  });
}

async function cancelPendingLogin(state: LoginState, reason: Exclude<LoginAbortReason, "timeout">): Promise<void> {
  if (state.status !== "pending") return;
  state.abortReason = reason;
  state.abortController.abort(new Error(`oauth_login_${reason}`));
  await state.completion;
}

function clearLoginTimeout(state: LoginState): void {
  if (state.timeout) clearTimeout(state.timeout);
  state.timeout = undefined;
}

function publicLoginFailure(state: LoginState, _error: unknown): { code: string; message: string } {
  if (state.abortReason === "timeout") {
    return { code: "oauth_login_timeout", message: "Codex OAuth 登录已超时，请重新生成登录地址" };
  }
  if (state.abortReason === "restarted") {
    return { code: "oauth_login_restarted", message: "已生成新的 Codex OAuth 登录地址" };
  }
  if (state.abortReason === "logout") {
    return { code: "oauth_login_cancelled", message: "Codex OAuth 登录已取消" };
  }
  return { code: "oauth_login_failed", message: "Codex OAuth 登录失败，请重新生成登录地址" };
}

function withRunnerOAuthOriginator(info: OAuthAuthInfo): OAuthAuthInfo {
  try {
    const url = new URL(info.url);
    if (url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize") return info;
    url.searchParams.set("originator", RUNNER_OAUTH_ORIGINATOR);
    return { ...info, url: url.toString() };
  } catch {
    return info;
  }
}

function codexHome(): string {
  return cleanString(process.env.CODEX_HOME) || join(homedir(), ".codex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordOAuthAudit(db: RunnerDatabase, eventType: string, status: string, error = ""): void {
  createPiActionEvent(db, {
    action_id: `provider-oauth:${OPENAI_CODEX_PROVIDER}:${crypto.randomUUID()}`,
    actor: "user",
    error,
    event_type: eventType,
    payload_json: JSON.stringify({ provider_id: OPENAI_CODEX_PROVIDER, source: "settings_http" }),
    reason: `${eventType} for ${OPENAI_CODEX_PROVIDER}`,
    result_json: JSON.stringify({ status })
  });
}
