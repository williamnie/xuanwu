import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { updatePiSupervisor } from "../db/repositories/pi.ts";
import { createDatabaseSecretService } from "../security/secrets/service.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];
const testServers: Array<ReturnType<typeof Bun.serve>> = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-provider-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (testServers.length > 0) testServers.pop()?.stop(true);
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI provider settings API", () => {
  test("returns stable provider presets and built-in model discovery without secrets", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/provider-settings/catalog`));

      expect(response.status).toBe(200);
      const body = await response.json() as { presets: Array<{ id: string; models: Array<{ id: string }> }> };
      expect(body.presets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          api: "openai-responses",
          auth: "api_key",
          id: "openai",
          recommended: true,
          recommended_model: "gpt-5.4"
        }),
        expect.objectContaining({ auth: "oauth", id: "openai-codex" }),
        expect.objectContaining({ auth: "api_key", id: "anthropic" })
      ]));
      const openai = body.presets.find((item: { id: string }) => item.id === "openai");
      expect(openai?.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4" })]));
      expect(JSON.stringify(body)).not.toContain("apiKey");
    } finally {
      database.close();
    }
  });

  test("upserts models.json providers without echoing API keys", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const empty = await router.handle(new Request(`${BASE_URL}/api/pi/provider-settings`));
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ providers: [] });

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://api.openai.example/v1",
        models: ["gpt-5.4", "gpt-5.5"]
      });

      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({
        id: "openai",
        api: "openai-responses",
        api_key_configured: true,
        base_url: "https://api.openai.example/v1",
        in_use: true,
        models: ["gpt-5.4", "gpt-5.5"]
      });
      expect(JSON.stringify(savedBody)).not.toContain("secret-key");

      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai.apiKey).toBeUndefined();
      expect(raw.providers.openai.apiKeyRef).toBe("secret://pi/provider/openai/api-key");
      const secretStore = await readFile(join(dirname(database.path), "secrets", "store.json"), "utf8");
      expect(secretStore).not.toContain("secret-key");
      expect(raw.providers.openai.models).toEqual([]);
      expect(Object.keys(raw.providers.openai.modelOverrides)).toEqual(["gpt-5.4", "gpt-5.5"]);
      const audit = database.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='provider_settings_updated' order by id desc limit 1"
      ).get();
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        credential_changed: true,
        provider_id: "openai"
      });
      expect(JSON.stringify(audit)).not.toContain("secret-key");
      const secretAudit = database.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='secret.created' order by id desc limit 1"
      ).get();
      expect(JSON.parse(secretAudit?.payload_json ?? "{}")).toMatchObject({
        secret_ref: "secret://pi/provider/openai/api-key",
        version: 1
      });

      await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "",
        base_url: "https://proxy.example/v1",
        models: "gpt-5.5"
      });
      const updated = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(updated.providers.openai).toMatchObject({
        apiKeyRef: "secret://pi/provider/openai/api-key",
        baseUrl: "https://proxy.example/v1",
        models: [],
        modelOverrides: { "gpt-5.5": {} }
      });
    } finally {
      database.close();
    }
  });

  test("omits empty credentials from sibling providers so one update cannot invalidate the model registry", async () => {
    const database = await openFixtureDatabase();
    try {
      await writeSeedModels(database, {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            apiKey: "",
            apiKeyRef: "",
            models: [{ id: "gpt-5.6-luna" }]
          }
        }
      });
      const router = createDefaultRouter({ database });
      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://proxy.example/v1",
        models: ["deepseek-v4-flash-0731"]
      });

      expect(saved.status).toBe(200);
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers["openai-codex"].apiKey).toBeUndefined();
      expect(raw.providers["openai-codex"].apiKeyRef).toBeUndefined();
      const runtime = await ModelRuntime.create({
        authPath: authPath(database),
        modelsPath: modelsPath(database),
        refreshOnCreate: false
      });
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getModel("openai", "deepseek-v4-flash-0731")).toMatchObject({
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        id: "deepseek-v4-flash-0731",
        provider: "openai"
      });
    } finally {
      database.close();
    }
  });

  test("deletes an inactive API-key connection and revokes its stored secret", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/provider-settings/acme", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://proxy.example/v1",
        models: ["deepseek-v4-flash-0731"]
      });

      const deleted = await deleteRequest(router, "/api/pi/provider-settings/acme");
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({
        credential_revoked: true,
        deleted: true,
        oauth_disconnected: false,
        provider_id: "acme"
      });
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.acme).toBeUndefined();
      expect(createDatabaseSecretService(database).describe("secret://pi/provider/acme/api-key")?.status).toBe("revoked");
      const audit = database.sqlite.query<{ event_type: string; result_json: string }, []>(
        "select event_type, result_json from pi_action_events where event_type='provider_settings_deleted' order by id desc limit 1"
      ).get();
      expect(audit?.event_type).toBe("provider_settings_deleted");
      expect(JSON.parse(audit?.result_json ?? "{}")).toMatchObject({ credential_status: "revoked", status: "succeeded" });
    } finally {
      database.close();
    }
  });

  test("protects the active connection and removes PI OAuth when its inactive provider is deleted", async () => {
    const database = await openFixtureDatabase();
    try {
      await writeSeedModels(database, {
        providers: {
          "openai-codex": { api: "openai-codex-responses", models: [{ id: "gpt-5.6-luna" }] }
        }
      });
      await writeSeedAuth(database, {
        "openai-codex": { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 }
      });
      const router = createDefaultRouter({ database });

      updatePiSupervisor(database, { model_provider: "openai-codex", model_id: "gpt-5.6-luna" });
      const blocked = await deleteRequest(router, "/api/pi/provider-settings/openai-codex");
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ message: "当前 Supervisor 正在使用此连接，请先切换并保存其他连接" });

      updatePiSupervisor(database, { model_provider: "openai", model_id: "gpt-5.4" });
      const deleted = await deleteRequest(router, "/api/pi/provider-settings/openai-codex");
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ deleted: true, oauth_disconnected: true, provider_id: "openai-codex" });
      const models = JSON.parse(await readFile(modelsPath(database), "utf8"));
      const auth = JSON.parse(await readFile(authPath(database), "utf8"));
      expect(models.providers["openai-codex"]).toBeUndefined();
      expect(auth["openai-codex"]).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test("does not replace built-in model metadata when saving built-in providers", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const builtIn = getModel("openai", "gpt-5.5");
      expect(builtIn?.contextWindow).toBeGreaterThan(128000);

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://proxy.example/v1",
        models: "gpt-5.5"
      });

      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ models: ["gpt-5.5"] });
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai.models).toEqual([]);
      expect(raw.providers.openai.modelOverrides).toEqual({ "gpt-5.5": {} });
      expect(JSON.stringify(raw.providers.openai)).not.toContain("\"contextWindow\":128000");
    } finally {
      database.close();
    }
  });

  test("omits an empty base URL so custom Codex OAuth models remain loadable", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const saved = await request(router, "/api/pi/provider-settings/openai-codex", {
        api: "openai-codex-responses",
        base_url: "",
        models: ["gpt-5.6-luna"]
      });

      expect(saved.status).toBe(200);
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers["openai-codex"].baseUrl).toBeUndefined();

      const runtime = await ModelRuntime.create({
        authPath: join(dirname(database.path), "pi-runtime", "agent", "auth.json"),
        modelsPath: modelsPath(database),
        refreshOnCreate: false
      });
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getModel("openai-codex", "gpt-5.6-luna")).toMatchObject({
        id: "gpt-5.6-luna",
        provider: "openai-codex"
      });
    } finally {
      database.close();
    }
  });

  test("keeps existing provider compatibility fields while updating", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await writeSeedModels(database, {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: "old-key",
            baseUrl: "https://old.example/v1",
            compat: { disableParallelToolCalls: true },
            models: [{ id: "old-model" }]
          }
        }
      });

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        base_url: "https://new.example/v1",
        models: ["new-model"]
      });

      expect(saved.status).toBe(200);
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai).toMatchObject({
        api: "openai-responses",
        apiKey: "old-key",
        baseUrl: "https://new.example/v1",
        compat: { disableParallelToolCalls: true },
        models: [{ id: "new-model" }]
      });
    } finally {
      database.close();
    }
  });

  test("persists provider user agent as request header without dropping existing headers", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await writeSeedModels(database, {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "old-key",
            headers: { "X-Trace": "keep" },
            modelOverrides: { "gpt-5.4": {} }
          }
        }
      });

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        models: "gpt-5.4",
        user_agent: "Xuanwu/1.0 PI"
      });

      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        id: "openai",
        user_agent: "Xuanwu/1.0 PI"
      });
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai.headers).toEqual({
        "X-Trace": "keep",
        "User-Agent": "Xuanwu/1.0 PI"
      });
    } finally {
      database.close();
    }
  });

  test("tests a custom OpenAI-compatible provider, discovers models, and records redacted audit", async () => {
    const database = await openFixtureDatabase();
    let authorization = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        if (new URL(request.url).pathname === "/v1/models") {
          return Response.json({ data: [{ id: "custom-reasoner" }, { id: "custom-fast" }] });
        }
        return new Response("missing", { status: 404 });
      }
    });
    testServers.push(server);
    try {
      const router = createDefaultRouter({ database });
      const secret = "custom-secret-key";
      await request(router, "/api/pi/provider-settings/acme", {
        api: "openai-responses",
        api_key: secret,
        base_url: `http://127.0.0.1:${server.port}/v1`,
        models: "custom-reasoner"
      });

      const response = await post(router, "/api/pi/provider-settings/acme/test-connection", {});

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        auth: "api_key",
        http_status: 200,
        models: ["custom-reasoner", "custom-fast"],
        ok: true,
        provider_id: "acme",
        status: "connected"
      });
      expect(authorization).toBe(`Bearer ${secret}`);
      expect(JSON.stringify(body)).not.toContain(secret);
      const audit = database.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='provider_connection_tested' order by id desc limit 1"
      ).get();
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        api: "openai-responses",
        base_url: `http://127.0.0.1:${server.port}/v1`,
        provider_id: "acme"
      });
      expect(JSON.parse(audit?.result_json ?? "{}")).toMatchObject({ discovered_model_count: 2, status: "connected" });
      expect(JSON.stringify(audit)).not.toContain(secret);

      const discovery = await post(router, "/api/pi/provider-settings/acme/models", {});
      expect(await discovery.json()).toMatchObject({
        models: ["custom-reasoner", "custom-fast"],
        ok: true,
        provider_id: "acme"
      });
    } finally {
      database.close();
    }
  });

  test("returns a sanitized failed connection result without exposing provider response or key", async () => {
    const database = await openFixtureDatabase();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("denied for failed-secret-key", { status: 401 });
      }
    });
    testServers.push(server);
    try {
      const router = createDefaultRouter({ database });
      const response = await post(router, "/api/pi/provider-settings/broken/test-connection", {
        api: "openai-responses",
        api_key: "failed-secret-key",
        base_url: `http://127.0.0.1:${server.port}/v1`
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        error: "provider_http_error",
        http_status: 401,
        models: [],
        ok: false,
        provider_id: "broken",
        status: "failed"
      });
      expect(JSON.stringify(body)).not.toContain("failed-secret-key");
      const audit = database.sqlite.query<{ error: string; payload_json: string; result_json: string }, []>(
        "select error, payload_json, result_json from pi_action_events where event_type='provider_connection_tested' order by id desc limit 1"
      ).get();
      expect(JSON.stringify(audit)).not.toContain("failed-secret-key");
      expect(JSON.parse(audit?.result_json ?? "{}")).toMatchObject({ http_status: 401, status: "failed" });
    } finally {
      database.close();
    }
  });

  test("reports Codex OAuth credential connection state without echoing OAuth tokens", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({
        database,
        providers: {
          codex: {
            id: "codex",
            capabilities: [],
            async listModels() {
              return { data: [{ id: "gpt-5.6", name: "GPT-5.6" }, { id: "gpt-5.5", name: "GPT-5.5" }] };
            },
            async run() {
              throw new Error("not used");
            }
          }
        }
      });
      const missing = await post(router, "/api/pi/provider-settings/openai-codex/test-connection", {});
      expect(await missing.json()).toMatchObject({
        auth: "oauth",
        error: "oauth_not_configured",
        ok: false,
        provider_id: "openai-codex"
      });

      const authPath = join(dirname(database.path), "pi-runtime", "agent", "auth.json");
      await mkdir(dirname(authPath), { recursive: true });
      await Bun.write(authPath, JSON.stringify({
        "openai-codex": { type: "oauth", access: "oauth-access-secret", refresh: "oauth-refresh-secret", expires: Date.now() + 60_000 }
      }));
      const configured = await post(router, "/api/pi/provider-settings/openai-codex/test-connection", {});
      const body = await configured.json() as { models: string[]; [key: string]: unknown };
      expect(body).toMatchObject({ auth: "oauth", ok: true, provider_id: "openai-codex", status: "connected" });
      expect(body.models).toEqual(["gpt-5.6", "gpt-5.5"]);
      expect(JSON.stringify(body)).not.toContain("oauth-access-secret");
      const audits = database.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='provider_connection_tested' order by id"
      ).all();
      expect(JSON.stringify(audits)).not.toContain("oauth-access-secret");
      expect(JSON.stringify(audits)).not.toContain("oauth-refresh-secret");
    } finally {
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function post(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function deleteRequest(router: ReturnType<typeof createDefaultRouter>, path: string) {
  return router.handle(new Request(`${BASE_URL}${path}`, { method: "DELETE" }));
}

function modelsPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "pi-runtime", "agent", "models.json");
}

function authPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "pi-runtime", "agent", "auth.json");
}

async function writeSeedModels(database: RunnerDatabase, value: Record<string, unknown>): Promise<void> {
  const path = modelsPath(database);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSeedAuth(database: RunnerDatabase, value: Record<string, unknown>): Promise<void> {
  const path = authPath(database);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}
