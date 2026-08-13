import { asProviderId } from "../providers/types.ts";
import type { ProviderRegistry } from "../providers/core/registry.ts";
import { catalogEntryFromRegistry } from "../providers/core/catalog.ts";
import { json, jsonError } from "./errors.ts";
import type { Router } from "./router.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { parseExecutionPolicyWrite } from "../providers/core/policyPersistence.ts";
import { resolveExecutionPolicy } from "../providers/core/policyResolution.ts";
import { ExecutionPolicyError } from "../providers/core/policyContracts.ts";
import type { ProviderTransport } from "../providers/core/manifest.ts";

/**
 * P6：/api/providers Provider discovery API（设计 §3.7 / 计划 P6）。
 * 新 Provider 注册后自动出现在 catalog（selector/Session UI 读取），无需前端改动；
 * 未注册 Provider 不进入任何可提交 selector；not-ready 可见但 submittable=false。
 */
export function registerProvidersCatalogRoute(
  router: Router,
  context: { database?: RunnerDatabase; providersRegistry?: ProviderRegistry }
): void {
  router.get("/api/providers", () => {
    if (!context.providersRegistry) return json([]);
    return json(context.providersRegistry.list().map(catalogEntryFromRegistry));
  });
  router.get("/api/providers/:id/models", async (request: Request) => {
    if (!context.providersRegistry) return jsonError(404, "provider catalog unavailable");
    const parts = new URL(request.url).pathname.split("/");
    const id = decodeURIComponent(parts.at(-2) ?? "");
    try {
      const provider = context.providersRegistry.getReady(asProviderId(id));
      if (!provider.capabilities.includes("model_list") || !provider.listModels) {
        return jsonError(409, `provider "${id}" does not support model_list`);
      }
      return json({ data: await provider.listModels() });
    } catch (error) {
      return jsonError(409, redactedUserVisibleText(error instanceof Error ? error.message : `provider "${id}" is not ready`));
    }
  });
  router.post("/api/providers/:id/execution-policy/resolve", async (request: Request) => {
    if (!context.providersRegistry) return jsonError(404, "provider catalog unavailable");
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[parts.indexOf("providers") + 1] ?? "");
    try {
      const provider = context.providersRegistry.getReady(asProviderId(id));
      const capabilities = provider.manifest.executionPolicy;
      if (!capabilities || !provider.policyAdapter) return jsonError(409, `provider "${id}" does not support execution policy resolution`);
      const body = await request.json() as Record<string, unknown>;
      const policy = parseExecutionPolicyWrite(body.policy, { allowEmpty: false })!;
      const projectID = typeof body.project_id === "string" ? body.project_id.trim() : "";
      const project = projectID && context.database ? getProject(context.database, projectID) : null;
      const runtime = provider.runtimeStatus?.();
      const transport = resolveTransport(provider.manifest.transports, body.transport, runtime?.mode);
      const resolved = resolveExecutionPolicy(policy, {
        cwd: project?.cwd ?? "",
        invocationRef: `policy-preview:${crypto.randomUUID()}`,
        projectId: projectID,
        providerId: provider.manifest.id,
        providerVersion: runtime?.version ?? "",
        source: "local-user",
        transport
      }, capabilities, provider.policyAdapter);
      return json({
        supported: true,
        requested: resolved.requested,
        isolation: resolved.isolation,
        effects: effectSummary(resolved.effects.toolEffects),
        native_summary: resolved.nativeSummary,
        proof: resolved.proof,
        warnings: resolved.warnings,
        transport
      });
    } catch (error) {
      if (error instanceof ExecutionPolicyError && error.code === "policy_combination_unsupported") {
        return json({
          supported: false,
          code: error.code,
          reason: error.message,
          alternatives: error.details.alternatives ?? []
        });
      }
      return jsonError(400, redactedUserVisibleText(error instanceof Error ? error.message : String(error)));
    }
  });
  router.get("/api/providers/:id", (request: Request) => {
    if (!context.providersRegistry) return jsonError(404, "provider catalog unavailable");
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    try {
      return json(catalogEntryFromRegistry(context.providersRegistry.describe(asProviderId(id))));
    } catch {
      return jsonError(404, `provider "${id}" is not registered`);
    }
  });
}

function resolveTransport(
  supported: readonly ProviderTransport[],
  requested: unknown,
  runtimeMode: string | undefined
): ProviderTransport {
  const explicit = typeof requested === "string" ? requested.trim() : "";
  const runtime = runtimeMode?.trim() === "cli-fallback" ? "stdio-json" : runtimeMode?.trim() ?? "";
  const value = explicit || runtime || supported[0] || "sdk";
  if (!supported.includes(value as ProviderTransport)) throw new Error(`transport ${value} is not supported`);
  return value as ProviderTransport;
}

function effectSummary(effects: Array<{ decision: string; toolFamily: string }>): Record<string, string> {
  const decision = (families: string[]) => {
    const values = effects.filter((effect) => families.includes(effect.toolFamily)).map((effect) => effect.decision);
    if (values.includes("deny")) return values.every((value) => value === "deny") ? "deny" : "limited";
    if (values.includes("host_prompt")) return "ask";
    if (values.includes("provider_prompt")) return "provider-prompt";
    return values.length > 0 ? "allow" : "unknown";
  };
  return {
    read: decision(["read"]),
    write: decision(["write", "write-sensitive", "external-path"]),
    command: decision(["command", "command-sensitive"]),
    network: decision(["network"])
  };
}
