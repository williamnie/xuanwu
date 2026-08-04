import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  for (let i = 0; i < 20; i += 1) {
    try {
      const raw = JSON.parse(await readFile(piAuthPath(database), "utf8"));
      if (raw["openai-codex"]?.access === "new-access") return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for oauth credentials");
}
