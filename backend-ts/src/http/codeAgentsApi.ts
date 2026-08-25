import type { RunnerConfig } from "../config/env.ts";
import { localSettingsPath, updateLocalSettingsFile, type RunnerLocalSettings } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import {
  managedCodeAgentCatalog,
  MANAGED_CODE_AGENT_IDS,
  type ManagedCodeAgentID
} from "../providers/core/codeAgentDirectory.ts";
import type { ProviderRegistry } from "../providers/core/registry.ts";
import { asProviderId, type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type CodeAgentsContext = {
  config: RunnerConfig;
  database: RunnerDatabase;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  providersRegistry: ProviderRegistry;
};

export function registerCodeAgentsRoutes(router: Router, context: CodeAgentsContext): void {
  router.get("/api/code-agents", () => json(codeAgentsResponse(context)));
  router.post("/api/code-agents/discover", async () => {
    await context.providersRegistry.refreshConfigured(context.config.providers);
    syncReadyProviders(context);
    return json(codeAgentsResponse(context));
  });
  router.patch("/api/code-agents/:id", async (request: Request) => {
    const id = managedCodeAgentID(new URL(request.url).pathname.split("/").pop() ?? "");
    const body = await objectBody(request);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    const hasActiveProcess = context.providersRegistry.collectProcessLeases().some((lease) => String(lease.provider) === id);
    if (!body.enabled && (activeRunCount(context.database, id) > 0 || hasActiveProcess)) {
      throw new HttpError(409, `code agent "${id}" has active runs and cannot be disabled`);
    }
    const current = context.config.providers[id];
    if (!current) throw new HttpError(404, `code agent "${id}" is not configured`);
    await persistEnabled(context.config.stateDir, id, body.enabled);
    current.enabled = body.enabled;
    await context.providersRegistry.setEnabled(asProviderId(id), body.enabled, current);
    syncReadyProviders(context);
    return json(codeAgentsResponse(context));
  });
}

function codeAgentsResponse(context: CodeAgentsContext): Record<string, unknown> {
  const agents = managedCodeAgentCatalog(context.providersRegistry);
  return {
    agents,
    available_ids: agents.filter((agent) => agent.enabled && agent.submittable).map((agent) => agent.id),
    settings_file: localSettingsPath(context.config.stateDir)
  };
}

function managedCodeAgentID(value: string): ManagedCodeAgentID {
  if (MANAGED_CODE_AGENT_IDS.includes(value as ManagedCodeAgentID)) return value as ManagedCodeAgentID;
  throw new HttpError(404, `code agent "${value}" is not managed`);
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "request body must be an object");
  return body as Record<string, unknown>;
}

function activeRunCount(database: RunnerDatabase, provider: string): number {
  return database.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from issue_runs where ended_at='' and provider=?"
  ).get(provider)?.count ?? 0;
}

async function persistEnabled(stateDir: string, id: ManagedCodeAgentID, enabled: boolean): Promise<void> {
  await updateLocalSettingsFile(localSettingsPath(stateDir), (settings) => withEnabled(settings, id, enabled));
}

function withEnabled(settings: RunnerLocalSettings, id: ManagedCodeAgentID, enabled: boolean): RunnerLocalSettings {
  const providers = settings.providers ?? {};
  if (id === "codex") {
    return { ...settings, providers: { ...providers, codex: { ...providers.codex, enabled } } };
  }
  if (id === "claude") {
    return { ...settings, providers: { ...providers, claude: { ...providers.claude, enabled } } };
  }
  if (id === "qoder") {
    return { ...settings, providers: { ...providers, qoder: { ...providers.qoder, enabled } } };
  }
  return {
    ...settings,
    providers: { ...providers, "pi-coding-agent": { ...providers["pi-coding-agent"], enabled } }
  };
}

function syncReadyProviders(context: Pick<CodeAgentsContext, "providers" | "providersRegistry">): void {
  const ready = context.providersRegistry.readyProviders();
  for (const id of MANAGED_CODE_AGENT_IDS) delete context.providers[id];
  for (const [id, provider] of Object.entries(ready)) {
    context.providers[id as ExecutorProviderId] = provider;
  }
}
