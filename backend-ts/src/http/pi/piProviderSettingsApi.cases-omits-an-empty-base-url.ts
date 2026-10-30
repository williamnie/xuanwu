import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piProviderSettingsApi.testFixture.ts";

export function registerOmitsAnEmptyBaseUrlCases(testScope: TestFixture) {
  const { openFixtureDatabase, testServers, request, post, modelsPath, authPath, writeSeedModels } = testScope;
  test("omits an empty base URL so custom Codex OAuth models remain loadable", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("keeps existing provider compatibility fields while updating", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("persists provider user agent as request header without dropping existing headers", async () => {
      const database = await openFixtureDatabase();
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
    });
}
