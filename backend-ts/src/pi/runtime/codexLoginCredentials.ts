import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { cleanString, objectValue } from "../../util/values.ts";

export const CODEX_REFRESH_THRESHOLD_MS = 30 * 60_000;
export const CODEX_REFRESH_INTERVAL_MS = 10 * 60_000;
export const CODEX_REFRESH_BACKOFF_MS = 5 * 60_000;
export class CodexLoginError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CodexLoginError"; }
}
type CodexLoginBinding = {
  home: string;
  managedHome: string;
  unavailable?: string;
  /** Identity of the existing managed transport, never a new app-server. */
  key: object;
  refresh?: () => Promise<void>;
};
type Snapshot = { credential?: OAuthCredential; account?: string; configured: boolean; auth_mode: string; error?: string };
const flights = new WeakMap<object, Promise<void>>();
const refreshBackoffs = new WeakMap<object, { home: string; access: string; retryAt: number; error?: string }>();
const claimKey = "https://api.openai.com/auth";
function claims(token: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))); }
  catch { return {}; }
}

/** Pure read. Neither the raw object nor a refresh/id token leaves this function. */
function readLogin(home: string): Snapshot {
  let raw: Record<string, unknown>;
  try { raw = objectValue(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))); }
  catch (error) {
    return { configured: false, auth_mode: "", error: (error as { code?: string }).code === "ENOENT" ? "codex_login_missing" : "invalid_auth_json" };
  }
  const tokens = objectValue(raw.tokens);
  const access = cleanString(tokens.access_token);
  const rawMode = cleanString(raw.auth_mode) || (access ? "chatgpt" : cleanString(raw.OPENAI_API_KEY) ? "apikey" : "");
  const mode = ["chatgpt", "apikey", "chatgptAuthTokens"].includes(rawMode) ? rawMode : "";
  const base = { configured: Boolean(access || cleanString(raw.OPENAI_API_KEY)), auth_mode: mode };
  if (mode !== "chatgpt") return { ...base, error: "codex_login_unsupported" };
  if (!access) return { ...base, error: "codex_login_missing" };
  const payload = claims(access);
  const account = cleanString(objectValue(payload[claimKey]).chatgpt_account_id);
  const fileAccount = cleanString(tokens.account_id);
  const idAccount = cleanString(objectValue(claims(cleanString(tokens.id_token))[claimKey]).chatgpt_account_id);
  if (!account) return { ...base, error: "codex_login_invalid_token" };
  if ((fileAccount && account !== fileAccount) || (idAccount && account !== idAccount)) return { ...base, error: "codex_login_account_mismatch" };
  const expires = typeof payload.exp === "number" ? payload.exp * 1000 : NaN;
  if (!Number.isSafeInteger(expires) || expires <= 0 || expires > 8.64e15) return { ...base, error: "codex_login_invalid_token" };
  return { ...base, account, credential: { type: "oauth", access, refresh: "", expires, accountId: account } };
}

export function createCodexLoginService(options: {
  role: "core" | "worker" | "replay";
  binding: () => CodexLoginBinding;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let failure: { key: object; code: string; access?: string } | undefined;
  function binding() {
    const value = options.binding();
    if (resolve(value.home) !== resolve(value.managedHome)) return { ...value, unavailable: "codex_login_home_mismatch" };
    return value;
  }
  function checked(value: CodexLoginBinding) {
    if (value.unavailable) throw new CodexLoginError(value.unavailable);
    const snapshot = readLogin(value.home);
    if (snapshot.error || !snapshot.credential) throw new CodexLoginError(snapshot.error ?? "codex_login_missing");
    return snapshot as Snapshot & { credential: OAuthCredential; account: string };
  }
  async function refresh(value: CodexLoginBinding, previous: OAuthCredential) {
    if (options.role !== "core") throw new CodexLoginError("codex_login_expired");
    if (!value.refresh) throw new CodexLoginError("codex_account_unavailable");
    let pending = flights.get(value.key);
    if (!pending) {
      pending = Promise.resolve().then(value.refresh);
      flights.set(value.key, pending);
    }
    try {
      await pending;
      const currentBinding = binding();
      if (currentBinding.key !== value.key || resolve(currentBinding.home) !== resolve(value.home)) throw new CodexLoginError("codex_login_home_mismatch");
      const result = checked(currentBinding);
      if (result.account !== previous.accountId) throw new CodexLoginError("codex_login_account_mismatch");
      if (result.credential.expires <= now()) throw new CodexLoginError("codex_login_expired");
      if (result.credential.access === previous.access) {
        refreshBackoffs.set(value.key, { home: resolve(value.home), access: previous.access, retryAt: now() + CODEX_REFRESH_BACKOFF_MS });
      } else refreshBackoffs.delete(value.key);
      failure = undefined;
      return result.credential;
    } catch (error) {
      // Never retain the provider error/cause: it may contain credentials or account data.
      const code = error instanceof CodexLoginError ? error.code : "codex_login_refresh_failed";
      refreshBackoffs.set(value.key, { home: resolve(value.home), access: previous.access, retryAt: now() + CODEX_REFRESH_BACKOFF_MS, error: code });
      const current = readLogin(value.home).credential;
      failure = { key: value.key, code, access: current?.access };
      // A transient refresh failure does not invalidate the still-current token.
      // Binding/account/file changes still fail closed; never resurrect a revoked login.
      const currentBinding = binding();
      if (code === "codex_login_refresh_failed" && previous.expires > now()
        && !currentBinding.unavailable && currentBinding.key === value.key
        && resolve(currentBinding.home) === resolve(value.home) && current?.access === previous.access) return previous;
      throw new CodexLoginError(code);
    } finally {
      if (flights.get(value.key) === pending) flights.delete(value.key);
    }
  }
  async function read(refreshSoon: boolean) {
    const value = binding();
    const snapshot = checked(value);
    // Expiry always bypasses backoff, including modify's mandatory reread path.
    if (snapshot.credential.expires <= now()) {
      if (options.role === "core") return refresh(value, snapshot.credential);
      throw new CodexLoginError("codex_login_expired");
    }
    if (refreshSoon && options.role === "core" && snapshot.credential.expires - now() < CODEX_REFRESH_THRESHOLD_MS) {
      const backoff = refreshBackoffs.get(value.key);
      if (backoff?.home === resolve(value.home) && backoff.access === snapshot.credential.access && now() < backoff.retryAt) {
        if (backoff.error && backoff.error !== "codex_login_refresh_failed") throw new CodexLoginError(backoff.error);
        if (backoff.error) failure = { key: value.key, code: backoff.error, access: snapshot.credential.access };
        return snapshot.credential;
      }
      return refresh(value, snapshot.credential);
    }
    return snapshot.credential;
  }
  const credentials: CredentialStore = {
    async read(id) { return id === "openai-codex" ? read(true) : undefined; },
    async list() { return status().available ? [{ providerId: "openai-codex", type: "oauth" }] : []; },
    // Deliberately NEVER execute fn. pi performs its own refresh inside that callback.
    async modify(id, _fn, options) {
      options?.signal?.throwIfAborted();
      if (id !== "openai-codex") throw new CodexLoginError("codex_login_read_only");
      return read(false);
    },
    async delete() { throw new CodexLoginError("codex_login_read_only"); }
  };
  function status() {
    const value = binding();
    const snapshot = readLogin(value.home);
    const error = value.unavailable || snapshot.error
      || (failure?.key === value.key && failure.access === snapshot.credential?.access ? failure.code : undefined)
      || (snapshot.credential && snapshot.credential.expires <= now() ? "codex_login_expired" : undefined);
    return {
      source: "codex_login" as const,
      configured: snapshot.configured,
      auth_mode: snapshot.auth_mode,
      path: join(value.home, "auth.json"),
      storage: "file" as const,
      available: Boolean(snapshot.credential && snapshot.credential.expires > now()
        && (!error || error === "codex_login_refresh_failed")),
      ...(snapshot.credential ? { expires_at: new Date(snapshot.credential.expires).toISOString() } : {}),
      ...(error ? { error } : {})
    };
  }
  const readOnlyCredentials: CredentialStore = {
    ...credentials,
    async read(id) {
      if (id !== "openai-codex") return undefined;
      const result = checked(binding()).credential;
      if (result.expires <= now()) throw new CodexLoginError("codex_login_expired");
      return result;
    },
    async modify(id) { return readOnlyCredentials.read(id); }
  };
  return { credentials, readOnlyCredentials, status, maintain: () => read(true) };
}
export type CodexLoginService = ReturnType<typeof createCodexLoginService>;

export function codexLoginFailureCode(error: unknown): string {
  if (error instanceof CodexLoginError) return error.code;
  // SDK wraps store errors; match only our fixed vocabulary, never return raw text/cause.
  const message = error instanceof Error ? error.message : "";
  const codes = ["codex_login_missing", "invalid_auth_json", "codex_login_unsupported", "codex_login_invalid_token",
    "codex_login_account_mismatch", "codex_login_home_mismatch", "codex_login_expired", "codex_account_unavailable",
    "codex_provider_disabled", "codex_provider_unavailable", "codex_login_refresh_failed"];
  return codes.find(code => message.includes(code)) ?? "codex_login_refresh_failed";
}
