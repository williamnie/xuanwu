import { credentialSource, type CredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { HttpError, json } from "../errors.ts";
import type { Router } from "../router.ts";
import { createDatabaseSecretService } from "../../security/secrets/service.ts";
import { cleanString } from "../../util/values.ts";
import type { PiProviderSettingsContext, ProviderConnectionResult, ProviderConfig, ProviderPreset } from "./piProviderSettingsApi.model.ts";
import { listProviderSettings, providerCatalog, upsertProviderSettings, providerID, parseObjectBody, auditBaseUrl } from "./piProviderSettingsApi.upsertProviderSettings.ts";
import { deleteProviderSettings, oauthModelDiscoveryResult, probeApiKeyProvider } from "./piProviderSettingsApi.probeApiKeyProvider.ts";
import { readModelsConfig, modelsPath, PROVIDER_PRESETS } from "./piProviderSettingsApi.normalizeModelsConfig.ts";

export function registerPiProviderSettingsRoutes(
  router: Router,
  context: PiProviderSettingsContext
): void {
  const activeContext = { ...context, secrets: context.secrets ?? createDatabaseSecretService(context.database) };
  router.get("/api/pi/provider-settings", async () => json(await listProviderSettings(activeContext)));
  router.get("/api/pi/provider-settings/catalog", () => json(providerCatalog()));
  router.put("/api/pi/provider-settings/:id", async (request) => {
    return json(await upsertProviderSettings(activeContext, providerID(request), await parseObjectBody(request)));
  });
  router.delete("/api/pi/provider-settings/:id", async (request) => {
    return json(await deleteProviderSettings(activeContext, providerID(request)));
  });
  router.post("/api/pi/provider-settings/:id/models", async (request) => {
    return json(await discoverProviderModels(activeContext, providerID(request), await parseObjectBody(request)));
  });
  router.post("/api/pi/provider-settings/:id/test-connection", async (request) => {
    return json(await testProviderConnection(activeContext, providerID(request), await parseObjectBody(request)));
  });
}

export async function testProviderConnection(
  context: PiProviderSettingsContext,
  id: string,
  body: Record<string, unknown>
): Promise<ProviderConnectionResult> {
  const startedAt = Date.now();
  const config = await readModelsConfig(modelsPath(context.database));
  const current = config.providers[id] ?? {};
  const preset = PROVIDER_PRESETS.find((item) => item.id === id);
  const result = await discoverProviderModels(context, id, body, current, preset);
  recordProviderConnectionAudit(context.database, id, body, current, preset, result, Date.now() - startedAt);
  return result;
}

export async function discoverProviderModels(
  context: PiProviderSettingsContext,
  id: string,
  body: Record<string, unknown>,
  current?: ProviderConfig,
  preset?: ProviderPreset
): Promise<ProviderConnectionResult> {
  let source: CredentialSource | undefined;
  try { if (body.credential_source !== undefined) source = credentialSource(body.credential_source); }
  catch { throw new HttpError(400, "credential_source must be stored or codex_login"); }
  if (source === "codex_login" && (id !== "openai-codex" || Object.entries(body).some(([key, value]) =>
    key !== "credential_source" && /token|secret|credential|api.?key/i.test(key) && value !== "" && value !== undefined))) {
    throw new HttpError(400, "codex_login accepts a source selection, not credentials");
  }
  const config = current ? undefined : await readModelsConfig(modelsPath(context.database));
  const activeCurrent = current ?? config?.providers[id] ?? {};
  const activePreset = preset ?? PROVIDER_PRESETS.find((item) => item.id === id);
  if ((activePreset?.auth ?? "api_key") === "oauth") {
    return await oauthModelDiscoveryResult(context, id, source);
  }
  return await probeApiKeyProvider(id, body, activeCurrent, activePreset, context.secrets!);
}

export function recordProviderConnectionAudit(
  database: RunnerDatabase,
  providerID: string,
  body: Record<string, unknown>,
  current: ProviderConfig,
  preset: ProviderPreset | undefined,
  result: ProviderConnectionResult,
  durationMs: number
): void {
  const api = cleanString(body.api) || current.api || preset?.api || "";
  const baseUrl = cleanString(body.base_url) || cleanString(body.baseUrl) || current.baseUrl || preset?.base_url || "";
  createPiActionEvent(database, {
    action_id: `provider-connection-test:${providerID}:${crypto.randomUUID()}`,
    actor: "user",
    error: result.error || "",
    event_type: "provider_connection_tested",
    payload_json: JSON.stringify({
      api,
      auth: result.auth,
      base_url: auditBaseUrl(baseUrl),
      provider_id: providerID,
      source: "settings_http"
    }),
    reason: `tested provider connection for ${providerID}`,
    result_json: JSON.stringify({
      discovered_model_count: result.models.length,
      duration_ms: Math.max(0, Math.round(durationMs)),
      http_status: result.http_status,
      status: result.status
    })
  });
}
