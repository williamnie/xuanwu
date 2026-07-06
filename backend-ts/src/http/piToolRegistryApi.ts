import { getStoredAssistantTool } from "../db/repositories/toolRegistry.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import type { AssistantTool, ToolProvider } from "../pi/toolProviderEnvelope.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";
import type { RunnerDatabase } from "../db/database.ts";

type ToolRegistryContext = { database: RunnerDatabase };

export function registerPiToolRegistryRoutes(router: Router, context: ToolRegistryContext): void {
  router.get("/api/pi/tool-providers", () => json({ providers: publicProviders(context.database) }));
  router.get("/api/pi/tools", () => json({ tools: publicTools(context.database) }));
  router.get("/api/pi/tools/:id", (request) => toolResponse(context.database, request));
}

function toolResponse(db: RunnerDatabase, request: Request): Response {
  const snapshot = registrySnapshot(db);
  const tool = findTool(db, snapshot.tools, request);
  if (!tool) throw new HttpError(404, `tool 不存在: ${toolID(request)}`);
  return json({ tool: publicTool(tool, providerByID(snapshot.providers).get(tool.provider_id)) });
}

function publicProviders(db: RunnerDatabase): unknown[] {
  return registrySnapshot(db).providers.map((provider) => redactSecrets(provider));
}

function publicTools(db: RunnerDatabase): unknown[] {
  const snapshot = registrySnapshot(db);
  const providers = providerByID(snapshot.providers);
  return snapshot.tools.map((tool) => publicTool(tool, providers.get(tool.provider_id)));
}

function publicTool(tool: AssistantTool, provider?: ToolProvider): unknown {
  return redactSecrets({
    ...tool,
    permission_summary: {
      audit_redact: tool.audit.redact,
      level: tool.permission,
      requires_confirmation: tool.permission !== "read"
    },
    provider: provider ? providerSummary(provider) : { id: tool.provider_id }
  });
}

function registrySnapshot(db: RunnerDatabase): { providers: ToolProvider[]; tools: AssistantTool[] } {
  return loadAssistantToolRegistrySnapshot(db);
}

function findTool(db: RunnerDatabase, tools: AssistantTool[], request: Request): AssistantTool | undefined {
  const parsed = parseToolRef(request);
  if (parsed.providerID) return getStoredAssistantTool(db, parsed.providerID, parsed.name) ?? tools.find((tool) =>
    tool.provider_id === parsed.providerID && tool.name === parsed.name);
  const matches = tools.filter((tool) => tool.name === parsed.name);
  if (matches.length > 1) throw new HttpError(400, "tool id 需使用 provider:name");
  return matches[0];
}

function parseToolRef(request: Request): { name: string; providerID: string } | { name: string; providerID?: undefined } {
  const url = new URL(request.url);
  const id = toolID(request);
  const providerID = url.searchParams.get("provider_id")?.trim() ?? "";
  if (providerID !== "") return { name: id, providerID };
  const separator = id.indexOf(":");
  return separator > 0 ? { providerID: id.slice(0, separator), name: id.slice(separator + 1) } : { name: id };
}

function toolID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("tools") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "tool id 不能为空");
  return decodeURIComponent(value);
}

function providerByID(providers: ToolProvider[]): Map<string, ToolProvider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function providerSummary(provider: ToolProvider): Record<string, unknown> {
  return { id: provider.id, kind: provider.kind, name: provider.name, status: provider.status ?? "enabled" };
}

function redactSecrets(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, path));
  if (!isRecord(value)) return redactPrimitive(value, path);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    redactSecrets(child, [...path, key])
  ]));
}

function redactPrimitive(value: unknown, path: string[]): unknown {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return value;
  return shouldRedact(path) ? "[redacted]" : value;
}

function shouldRedact(path: string[]): boolean {
  const key = path.at(-1) ?? "";
  if (sensitiveKey(key)) return true;
  if (schemaSafeKey(key)) return false;
  return path.slice(0, -1).some(sensitiveKey) && valueBearingKey(key);
}

function sensitiveKey(key: string): boolean {
  return /secret|token|password|passwd|credential|api[_-]?key|authorization|auth[_-]?token|env/i.test(key);
}

function valueBearingKey(key: string): boolean {
  return /default|example|examples|const|enum|value|raw|payload|content|url|endpoint|header/i.test(key);
}

function schemaSafeKey(key: string): boolean {
  return ["type", "description", "title", "required", "properties", "additionalProperties"].includes(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
