import { codexLoginService, createPiModelRuntime, selectedCredentialSource, type CredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import { dirname, join } from "node:path";
import type { OAuthAuthInfo, OAuthCredentials } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { updatePiCredential } from "./piCredentialFile.ts";
import { type PiOAuthFailureDiagnostic } from "./piOAuthDiagnostics.ts";
import type { LoginState, PiOAuthLoginCallbacks, LoginAbortReason } from "./piOAuthApi.model.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export const RUNNER_OAUTH_ORIGINATOR = "pi-agent";

export const DEFAULT_OAUTH_LOGIN_TIMEOUT_MS = 10 * 60_000;

export const loginStates = new Map<string, LoginState>();

export async function defaultOpenAICodexLogin(
  db: RunnerDatabase,
  callbacks: PiOAuthLoginCallbacks,
  state: LoginState,
  signal?: AbortSignal
): Promise<OAuthCredentials> {
  const runtime = await createOAuthRuntime(db, signal, undefined, "stored");
  state.phase = "provider_login";
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

export function waitForPromptCancellation(signal: AbortSignal | undefined): Promise<string> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export async function completeLogin(
  db: RunnerDatabase,
  credentials: OAuthCredentials,
  state: LoginState,
  persistInjectedCredential: boolean
): Promise<void> {
  if (state.abortController.signal.aborted || loginStates.get(piAuthPath(db)) !== state) return;
  if (persistInjectedCredential) {
    state.phase = "credential_storage";
    await updatePiCredential(piAuthPath(db), OPENAI_CODEX_PROVIDER, { type: "oauth", ...credentials });
  }
  state.status = "authenticated";
  state.authUrl = undefined;
  state.instructions = undefined;
  state.error = undefined;
  state.message = "Codex OAuth 登录成功";
  state.phase = "complete";
  recordOAuthAudit(db, "provider_oauth_configured", "succeeded", "", state);
}

export async function oauthStatus(db: RunnerDatabase, readCodex = true) {
  const authPath = piAuthPath(db);
  const configured = await hasStoredPiCredential(authPath);
  const state = loginStates.get(authPath);
  const base = {
    provider: OPENAI_CODEX_PROVIDER,
    credential_source: selectedCredentialSource(db),
    pi_oauth: { configured, source: configured ? "stored" : "none", status: state?.status ?? "idle" },
    ...(readCodex ? { codex_login: codexLoginService(db).status() } : {})
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

export async function hasStoredPiCredential(authPath: string): Promise<boolean> {
  const { readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  return readStoredCredential(OPENAI_CODEX_PROVIDER, authPath) !== undefined;
}

export function pendingState(timeoutMs: number): LoginState {
  const state: LoginState = {
    attemptId: crypto.randomUUID(),
    abortController: new AbortController(),
    phase: "initializing_runtime",
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

export function piAuthPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "auth.json");
}

export function piModelsPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "models.json");
}

export async function createOAuthRuntime(db: RunnerDatabase, signal?: AbortSignal, source?: CredentialSource, mode: "assistant" | "stored" = "assistant") {
  const [{ registerBunOAuthFlows }, sdk] = await Promise.all([
    import("@earendil-works/pi-ai/bun-oauth"),
    import("@earendil-works/pi-coding-agent")
  ]);
  registerBunOAuthFlows();
  return await createPiModelRuntime(sdk, {
    database: db, source, mode,
    authPath: piAuthPath(db),
    modelsPath: piModelsPath(db),
    refreshOnCreate: false,
    signal
  });
}

export async function cancelPendingLogin(state: LoginState, reason: Exclude<LoginAbortReason, "timeout">): Promise<void> {
  if (state.status !== "pending") return;
  state.abortReason = reason;
  state.abortController.abort(new Error(`oauth_login_${reason}`));
  await state.completion;
}

export function publicLoginFailure(state: LoginState, diagnostic?: PiOAuthFailureDiagnostic): { code: string; message: string } {
  if (state.abortReason === "timeout") {
    return { code: "oauth_login_timeout", message: "Codex OAuth 登录已超时，请重新生成登录地址" };
  }
  if (state.abortReason === "restarted") {
    return { code: "oauth_login_restarted", message: "已生成新的 Codex OAuth 登录地址" };
  }
  if (state.abortReason === "logout") {
    return { code: "oauth_login_cancelled", message: "Codex OAuth 登录已取消" };
  }
  const detail = diagnostic?.category === "network" ? "后端网络请求失败"
    : diagnostic?.category === "provider_http" ? `交换凭据失败（HTTP ${diagnostic.http_status}）`
    : diagnostic?.category === "credential_storage" ? "本地凭据读写失败"
    : diagnostic?.category === "runtime_sync" ? "凭据已保存，但本地模型状态同步失败"
    : diagnostic?.category === "invalid_token_response" ? "授权服务返回的凭据格式异常"
    : diagnostic?.category === "callback" ? "授权回调失败"
    : "授权流程失败";
  return { code: "oauth_login_failed", message: `Codex OAuth 登录失败：${detail}。请查看服务日志 [pi-oauth]（诊断 ID：${state.attemptId}），然后重新生成登录地址` };
}

export function withRunnerOAuthOriginator(info: OAuthAuthInfo): OAuthAuthInfo {
  try {
    const url = new URL(info.url);
    if (url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize") return info;
    url.searchParams.set("originator", RUNNER_OAUTH_ORIGINATOR);
    return { ...info, url: url.toString() };
  } catch {
    return info;
  }
}

export function recordOAuthAudit(db: RunnerDatabase, eventType: string, status: string, error = "", state?: LoginState, diagnostic?: PiOAuthFailureDiagnostic): void {
  const details = state ? {
    attempt_id: state.attemptId,
    phase: state.phase,
    elapsed_ms: Math.max(0, Date.now() - Date.parse(state.startedAt)),
    ...(eventType === "provider_oauth_login_started" ? {
      proxy_env: {
        http: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
        https: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
        all: Boolean(process.env.ALL_PROXY || process.env.all_proxy)
      }
    } : {}),
    ...diagnostic
  } : {};
  console.info("[pi-oauth]", JSON.stringify({ event: eventType, provider: OPENAI_CODEX_PROVIDER, status, error, ...details }));
  createPiActionEvent(db, {
    action_id: `provider-oauth:${OPENAI_CODEX_PROVIDER}:${crypto.randomUUID()}`,
    actor: "user",
    error,
    event_type: eventType,
    payload_json: JSON.stringify({ provider_id: OPENAI_CODEX_PROVIDER, source: "settings_http" }),
    reason: `${eventType} for ${OPENAI_CODEX_PROVIDER}`,
    result_json: JSON.stringify({ status, ...details })
  });
}
