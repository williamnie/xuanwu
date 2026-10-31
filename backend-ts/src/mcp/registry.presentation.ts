import { cleanString, objectValue } from "../util/values.ts";
import type { McpCapability, McpRequirementRecommendation, McpServerRegistry, McpRegistryDiagnostic } from "./registry.model.ts";
import { diagnostic } from "./registry.values.ts";

export function recommendation(capability: McpCapability, terms: string[]): McpRequirementRecommendation {
  const haystack = tokenize(`${capability.id} ${capability.name} ${capability.description} ${capability.server_id}`);
  const matches = terms.filter((term) => haystack.some((word) => word.includes(term) || term.includes(word)));
  return { ...publicCapability(capability), reason: `matched ${matches.slice(0, 4).join(", ")}`, score: new Set(matches).size };
}

export function publicServer(server: McpServerRegistry): McpServerRegistry {
  const { transport: _transport, ...safe } = server;
  return {
    ...safe,
    capabilities: server.capabilities.map(publicCapability),
    resources: server.resources.map(publicCapability),
    tools: server.tools.map(publicCapability)
  };
}

export function publicCapability(capability: McpCapability): McpCapability {
  return capability;
}

export function serverDiagnostics(id: string, status: string, readiness: string): McpRegistryDiagnostic[] {
  const diagnostics: McpRegistryDiagnostic[] = [];
  if (isUnavailableStatus(status)) {
    diagnostics.push(diagnostic("server_unavailable", id, `MCP server ${id} is unavailable`, status, readiness));
  }
  if (isNotReady(readiness)) {
    diagnostics.push(diagnostic("server_not_ready", id, `MCP server ${id} readiness is ${readiness}`, status, readiness));
  }
  return diagnostics;
}

export function isUnavailableStatus(status: string): boolean {
  return ["disabled", "error", "failed", "missing", "offline", "unavailable"].includes(status.toLowerCase());
}

export function isNotReady(readiness: string): boolean {
  const value = readiness.toLowerCase();
  return value !== "" && !["available", "ready", "unknown"].includes(value);
}

export function issueText(issue: unknown): string {
  const object = objectValue(issue);
  return `${cleanString(object.title)} ${cleanString(object.description)}`;
}

export function tokenize(text: string): string[] {
  return cleanString(text).toLowerCase().split(/[^a-z0-9_:-]+/).filter((term) => term.length >= 3);
}

export function jsonSchema(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  const schema = objectValue(value);
  return Object.keys(schema).length > 0 ? schema : fallback;
}

export function emptyObjectSchema(): Record<string, unknown> {
  return { additionalProperties: false, properties: {}, type: "object" };
}

export function parseJSON(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function isRegistryObject(value: unknown): boolean {
  return value !== undefined && typeof value === "object" && !Array.isArray(value);
}
