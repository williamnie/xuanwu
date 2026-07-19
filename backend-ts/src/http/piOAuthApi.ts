import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthAuthInfo, OAuthCredentials, OAuthPrompt } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

export type PiOAuthLoginCallbacks = {
  onAuth: (info: OAuthAuthInfo) => void;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};
export type PiOpenAICodexOAuthLogin = (callbacks: PiOAuthLoginCallbacks) => Promise<OAuthCredentials>;
type PiOAuthContext = { database: RunnerDatabase; piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin };
type LoginState = { authUrl?: string; error?: string; instructions?: string; startedAt: string; status: "pending" | "authenticated" | "error" };

const OPENAI_CODEX_PROVIDER = "openai-codex";
const loginStates = new Map<string, LoginState>();

export function registerPiOAuthRoutes(router: Router, context: PiOAuthContext): void {
  router.get("/api/pi/oauth/openai-codex/status", async () => json(await oauthStatus(context.database)));
  router.post("/api/pi/oauth/openai-codex/login", async () => json(await startOpenAICodexLogin(context)));
  router.post("/api/pi/oauth/openai-codex/logout", async () => json(await logoutOpenAICodex(context.database)));
}

async function startOpenAICodexLogin(context: PiOAuthContext) {
  const authPath = piAuthPath(context.database);
  const existing = loginStates.get(authPath);
  if (existing?.status === "pending" && existing.authUrl) return await loginResponse(context.database, existing);
  const state = pendingState();
  loginStates.set(authPath, state);
  const authInfo = await beginLogin(context, state);
  state.authUrl = authInfo.url;
  state.instructions = authInfo.instructions;
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
  const login = context.piOpenAICodexOAuthLogin ?? defaultOpenAICodexLogin;
  void login({
    onAuth: (info) => { resolveAuth(info); },
    onPrompt: async () => { throw new Error("Manual OAuth code paste is not supported from Runner Settings yet."); }
  }).then((credentials) => storeCredentials(context.database, credentials, state))
    .catch((error) => {
      markLoginFailed(context.database, state, error);
      rejectAuth(error);
    });
  return authInfo;
}

async function defaultOpenAICodexLogin(callbacks: PiOAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { loginOpenAICodex } = await import("@earendil-works/pi-ai/oauth");
  return await loginOpenAICodex({
    onAuth: callbacks.onAuth,
    onPrompt: callbacks.onPrompt,
    onProgress: callbacks.onProgress,
    originator: "pi-agent"
  });
}

async function storeCredentials(db: RunnerDatabase, credentials: OAuthCredentials, state: LoginState): Promise<void> {
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  AuthStorage.create(piAuthPath(db)).set(OPENAI_CODEX_PROVIDER, { type: "oauth", ...credentials });
  state.status = "authenticated";
  recordOAuthAudit(db, "provider_oauth_configured", "succeeded");
}

function markLoginFailed(db: RunnerDatabase, state: LoginState, error: unknown): void {
  state.status = "error";
  state.error = error instanceof Error ? error.message : String(error);
  recordOAuthAudit(db, "provider_oauth_failed", "failed", "oauth_login_failed");
}

async function logoutOpenAICodex(db: RunnerDatabase) {
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  AuthStorage.create(piAuthPath(db)).remove(OPENAI_CODEX_PROVIDER);
  loginStates.delete(piAuthPath(db));
  recordOAuthAudit(db, "provider_oauth_logged_out", "succeeded");
  return await oauthStatus(db);
}

export async function isPiOpenAICodexOAuthConfigured(db: RunnerDatabase): Promise<boolean> {
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  return AuthStorage.create(piAuthPath(db)).getAuthStatus(OPENAI_CODEX_PROVIDER).configured;
}

async function oauthStatus(db: RunnerDatabase) {
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  const authPath = piAuthPath(db);
  const authStorage = AuthStorage.create(authPath);
  const piStatus = authStorage.getAuthStatus(OPENAI_CODEX_PROVIDER);
  const state = loginStates.get(authPath);
  const base = {
    provider: OPENAI_CODEX_PROVIDER,
    pi_oauth: { configured: piStatus.configured, source: piStatus.source ?? "none", status: state?.status ?? "idle" },
    codex_login: codexLoginStatus()
  };
  if (!state) return base;
  return { ...base, auth_url: state.authUrl ?? "", instructions: state.instructions ?? "", status: state.status };
}

async function loginResponse(db: RunnerDatabase, state: LoginState) {
  return { ...await oauthStatus(db), auth_url: state.authUrl ?? "", instructions: state.instructions ?? "", status: "pending" };
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

function pendingState(): LoginState {
  return { startedAt: new Date().toISOString(), status: "pending" };
}

function piAuthPath(db: RunnerDatabase): string {
  return join(dirname(db.path), "pi-runtime", "agent", "auth.json");
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
