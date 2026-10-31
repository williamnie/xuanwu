import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { updatePiSupervisor } from "../../db/repositories/pi.ts";
import { createDatabaseSecretService } from "../../security/secrets/service.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piProviderSettingsApi.testFixture.ts";

export function registerReturnsStableProviderPresetsAndCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, request, deleteRequest, modelsPath, authPath, writeSeedModels, writeSeedAuth } = testScope;
  test("returns stable provider presets and built-in model discovery without secrets", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("upserts models.json providers without echoing API keys", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("omits empty credentials from sibling providers so one update cannot invalidate the model registry", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("deletes an inactive API-key connection and revokes its stored secret", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("protects the active connection and removes PI OAuth when its inactive provider is deleted", async () => {
      const database = await openFixtureDatabase();
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
    });
  
  test("does not replace built-in model metadata when saving built-in providers", async () => {
      const database = await openFixtureDatabase();
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
    });
}
