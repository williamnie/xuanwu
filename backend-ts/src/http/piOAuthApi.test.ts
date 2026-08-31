import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-oauth-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI OAuth API", () => {
  test("reports PI OAuth and local Codex login status without exposing tokens", async () => {
    const database = await openFixtureDatabase();
    try {
      const codexHome = join(dirname(database.path), "codex-home");
      process.env.CODEX_HOME = codexHome;
      await writeJson(piAuthPath(database), {
        "openai-codex": { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: Date.now() + 60000, accountId: "acct-pi" }
      });
      await writeJson(join(codexHome, "auth.json"), {
        auth_mode: "chatgpt",
        tokens: { access_token: "codex-access", refresh_token: "codex-refresh", account_id: "acct-codex" }
      });

      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/status`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        provider: "openai-codex",
        pi_oauth: { configured: true, source: "stored" },
        codex_login: { configured: true, storage: "file" }
      });
      expect(JSON.stringify(body)).not.toContain("pi-access");
      expect(JSON.stringify(body)).not.toContain("codex-access");
      expect(JSON.stringify(body)).not.toContain("refresh");
    } finally {
      database.close();
    }
  });

  test("starts OpenAI Codex OAuth login and stores returned PI credentials", async () => {
    const database = await openFixtureDatabase();
    try {
      let finishLogin: ((value: void) => void) | undefined;
      const loginGate = new Promise<void>((resolve) => { finishLogin = resolve; });
      const router = createDefaultRouter({
        database,
        piOpenAICodexOAuthLogin: async (callbacks) => {
          callbacks.onAuth({ url: "https://auth.example/login", instructions: "sign in" });
          await loginGate;
          return { access: "new-access", refresh: "new-refresh", expires: 123456, accountId: "acct-new" };
        }
      });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/login`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "pending", auth_url: "https://auth.example/login" });
      const pending = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/status`));
      expect(await pending.json()).toMatchObject({ status: "pending", auth_url: "https://auth.example/login" });
      finishLogin?.();
      await waitForStoredAuth(database);
      const raw = JSON.parse(await readFile(piAuthPath(database), "utf8"));
      expect(raw["openai-codex"]).toMatchObject({ type: "oauth", accountId: "acct-new" });
      expect(raw["openai-codex"].access).toBe("new-access");
      const audit = database.sqlite.query<{ event_type: string; payload_json: string; result_json: string }, []>(
        "select event_type, payload_json, result_json from pi_action_events where event_type like 'provider_oauth_%' order by id"
      ).all();
      expect(audit.map((item) => item.event_type)).toEqual(expect.arrayContaining([
        "provider_oauth_login_started",
        "provider_oauth_configured"
      ]));
      expect(JSON.stringify(audit)).not.toContain("new-access");
      expect(JSON.stringify(audit)).not.toContain("new-refresh");
    } finally {
      database.close();
    }
  });

  test("restarts a pending login with a fresh OAuth transaction and cancels the old listener", async () => {
    const database = await openFixtureDatabase();
    try {
      let attempt = 0;
      let cancelled = 0;
      let finishLogin: ((value: OAuthCredentials) => void) | undefined;
      const router = createDefaultRouter({
        database,
        piOpenAICodexOAuthLogin: async (callbacks, signal) => {
          attempt += 1;
          const currentAttempt = attempt;
          callbacks.onAuth({
            url: `https://auth.openai.com/oauth/authorize?state=state-${currentAttempt}&originator=pi`,
            instructions: "sign in"
          });
          return await new Promise<OAuthCredentials>((resolve, reject) => {
            if (currentAttempt === 2) finishLogin = resolve;
            const onAbort = () => {
              cancelled += 1;
              reject(signal?.reason ?? new Error("aborted"));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      });

      const first = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/login`, { method: "POST" }));
      const firstBody = await first.json() as { auth_url: string; started_at: string };
      expect(new URL(firstBody.auth_url).searchParams.get("originator")).toBe("pi-agent");
      expect(firstBody.started_at).toBeString();

      const second = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/login`, { method: "POST" }));
      const secondBody = await second.json() as { auth_url: string; started_at: string };
      expect(attempt).toBe(2);
      expect(cancelled).toBe(1);
      expect(secondBody.auth_url).not.toBe(firstBody.auth_url);
      expect(new URL(secondBody.auth_url).searchParams.get("state")).toBe("state-2");
      expect(new URL(secondBody.auth_url).searchParams.get("originator")).toBe("pi-agent");

      finishLogin?.({ access: "fresh-access", refresh: "fresh-refresh", expires: 123456, accountId: "acct-fresh" });
      await waitForStoredAuthValue(database, "fresh-access");
      const audit = database.sqlite.query<{ event_type: string; error: string }, []>(
        "select event_type, error from pi_action_events where event_type like 'provider_oauth_%' order by id"
      ).all();
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: "provider_oauth_cancelled", error: "oauth_login_restarted" }),
        expect.objectContaining({ event_type: "provider_oauth_configured", error: "" })
      ]));
    } finally {
      database.close();
    }
  });

  test("times out a browser login and exposes a safe retryable status", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({
        database,
        piOAuthLoginTimeoutMs: 10,
        piOpenAICodexOAuthLogin: async (callbacks, signal) => {
          callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?state=timeout", instructions: "sign in" });
          return await new Promise<OAuthCredentials>((_, reject) => {
            const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/login`, { method: "POST" }));
      expect(await response.json()).toMatchObject({ status: "pending" });
      const status = await waitForOAuthStatus(router, "error");
      expect(status).toMatchObject({
        error: "oauth_login_timeout",
        message: "Codex OAuth 登录已超时，请重新生成登录地址",
        pi_oauth: { configured: false, status: "error" },
        status: "error"
      });
      const audit = database.sqlite.query<{ error: string; event_type: string }, []>(
        "select event_type, error from pi_action_events where event_type='provider_oauth_failed' order by id desc limit 1"
      ).get();
      expect(audit).toEqual({ error: "oauth_login_timeout", event_type: "provider_oauth_failed" });
    } finally {
      database.close();
    }
  });

  test("logs out PI OpenAI Codex OAuth without touching Codex CLI auth", async () => {
    const database = await openFixtureDatabase();
    try {
      const codexHome = join(dirname(database.path), "codex-home");
      process.env.CODEX_HOME = codexHome;
      await writeJson(piAuthPath(database), {
        "openai-codex": { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: Date.now() + 60000, accountId: "acct-pi" }
      });
      await writeJson(join(codexHome, "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: "codex-access" } });

      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/logout`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pi_oauth: { configured: false } });
      const piRaw = JSON.parse(await readFile(piAuthPath(database), "utf8"));
      expect(piRaw["openai-codex"]).toBeUndefined();
      const codexRaw = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
      expect(codexRaw.tokens.access_token).toBe("codex-access");
      const audit = database.sqlite.query<{ event_type: string; payload_json: string }, []>(
        "select event_type, payload_json from pi_action_events where event_type='provider_oauth_logged_out'"
      ).get();
      expect(audit?.event_type).toBe("provider_oauth_logged_out");
      expect(JSON.stringify(audit)).not.toContain("pi-access");
      expect(JSON.stringify(audit)).not.toContain("codex-access");
    } finally {
      database.close();
    }
  });
});

function piAuthPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "pi-runtime", "agent", "auth.json");
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function waitForStoredAuth(database: RunnerDatabase): Promise<void> {
  await waitForStoredAuthValue(database, "new-access");
}

async function waitForStoredAuthValue(database: RunnerDatabase, access: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      const raw = JSON.parse(await readFile(piAuthPath(database), "utf8"));
      if (raw["openai-codex"]?.access === access) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for oauth credentials");
}

async function waitForOAuthStatus(router: ReturnType<typeof createDefaultRouter>, status: string) {
  for (let i = 0; i < 40; i += 1) {
    const response = await router.handle(new Request(`${BASE_URL}/api/pi/oauth/openai-codex/status`));
    const body = await response.json() as Record<string, unknown>;
    if (body.status === status) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for OAuth status ${status}`);
}
