import { codexLoginService, selectedCredentialSource, type CredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import type { OAuthAuthInfo } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { HttpError, json } from "../errors.ts";
import type { Router } from "../router.ts";
import { diagnosePiOAuthFailure } from "./piOAuthDiagnostics.ts";
import type { PiOAuthContext, LoginState, PiOAuthLoginCallbacks } from "./piOAuthApi.model.ts";
import { oauthStatus, piAuthPath, loginStates, cancelPendingLogin, pendingState, DEFAULT_OAUTH_LOGIN_TIMEOUT_MS, recordOAuthAudit, defaultOpenAICodexLogin, withRunnerOAuthOriginator, completeLogin, publicLoginFailure, hasStoredPiCredential, createOAuthRuntime, OPENAI_CODEX_PROVIDER } from "./piOAuthApi.recordOAuthAudit.ts";

export function registerPiOAuthRoutes(router: Router, context: PiOAuthContext): void {
  router.get("/api/pi/oauth/openai-codex/status", async () => json(await oauthStatus(context.database)));
  router.post("/api/pi/oauth/openai-codex/login", async () => json(await startOpenAICodexLogin(context)));
  router.post("/api/pi/oauth/openai-codex/logout", async () => json(await logoutOpenAICodex(context.database)));
}

export async function startOpenAICodexLogin(context: PiOAuthContext) {
  const authPath = piAuthPath(context.database);
  const existing = loginStates.get(authPath);
  if (existing?.status === "pending") await cancelPendingLogin(existing, "restarted");
  const state = pendingState(context.piOAuthLoginTimeoutMs ?? DEFAULT_OAUTH_LOGIN_TIMEOUT_MS);
  loginStates.set(authPath, state);
  recordOAuthAudit(context.database, "provider_oauth_login_started", "pending", "", state);
  try {
    await beginLogin(context, state);
  } catch {
    throw new HttpError(502, state.message || "Codex OAuth 登录初始化失败，请重试");
  }
  return await loginResponse(context.database, state);
}

export function beginLogin(context: PiOAuthContext, state: LoginState): Promise<OAuthAuthInfo> {
  let resolveAuth: (info: OAuthAuthInfo) => void = () => {};
  let rejectAuth: (error: unknown) => void = () => {};
  const authInfo = new Promise<OAuthAuthInfo>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  const injectedLogin = context.piOpenAICodexOAuthLogin;
  const login = injectedLogin ?? ((callbacks: PiOAuthLoginCallbacks, signal?: AbortSignal) => (
    defaultOpenAICodexLogin(context.database, callbacks, state, signal)
  ));
  state.completion = login({
    onAuth: (info) => {
      const normalized = withRunnerOAuthOriginator(info);
      state.authUrl = normalized.url;
      state.instructions = normalized.instructions;
      state.phase = "provider_login";
      recordOAuthAudit(context.database, "provider_oauth_authorization_ready", "pending", "", state);
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

export function markLoginFailed(db: RunnerDatabase, state: LoginState, error: unknown): void {
  if (state.status === "authenticated") return;
  state.status = "error";
  const diagnostic = state.abortReason ? undefined : diagnosePiOAuthFailure(error, state.phase);
  const failure = publicLoginFailure(state, diagnostic);
  state.error = failure.code;
  state.message = failure.message;
  recordOAuthAudit(
    db,
    state.abortReason === "restarted" || state.abortReason === "logout"
      ? "provider_oauth_cancelled"
      : "provider_oauth_failed",
    state.abortReason === "restarted" || state.abortReason === "logout" ? "cancelled" : "failed",
    failure.code,
    state,
    diagnostic
  );
}

export async function removePiOpenAICodexOAuthCredential(db: RunnerDatabase): Promise<boolean> {
  const authPath = piAuthPath(db);
  const state = loginStates.get(authPath);
  if (state?.status === "pending") await cancelPendingLogin(state, "logout");
  loginStates.delete(authPath);
  const configured = await hasStoredPiCredential(piAuthPath(db));
  if (configured) {
    const runtime = await createOAuthRuntime(db, undefined, undefined, "stored");
    await runtime.logout(OPENAI_CODEX_PROVIDER);
  }
  if (configured) recordOAuthAudit(db, "provider_oauth_logged_out", "succeeded");
  return configured;
}

export async function logoutOpenAICodex(db: RunnerDatabase) {
  await removePiOpenAICodexOAuthCredential(db);
  return await oauthStatus(db, false);
}

export async function isPiOpenAICodexOAuthConfigured(db: RunnerDatabase, source?: CredentialSource): Promise<boolean> {
  if (selectedCredentialSource(db, source) === "codex_login") return codexLoginService(db).status().configured;
  return await hasStoredPiCredential(piAuthPath(db));
}

export async function discoverPiOpenAICodexModels(
  db: RunnerDatabase,
  signal?: AbortSignal,
  source?: CredentialSource
): Promise<string[]> {
  const runtime = await createOAuthRuntime(db, signal, source);
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

export async function loginResponse(db: RunnerDatabase, state: LoginState) {
  return {
    ...await oauthStatus(db, false),
    auth_url: state.authUrl ?? "",
    instructions: state.instructions ?? "",
    status: state.status
  };
}

export function clearLoginTimeout(state: LoginState): void {
  if (state.timeout) clearTimeout(state.timeout);
  state.timeout = undefined;
}
