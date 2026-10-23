import type { Project } from "../db/repositories/projects.ts";
import { cleanString } from "../util/values.ts";

type ProviderStatus = Record<string, unknown>;
type ReportWarning = { code: string; message: string; severity: string; source: string };

export function summarizeProviderHealth(
  project: Project | null,
  statuses: ProviderStatus[] | undefined
): Record<string, unknown> {
  const provider = project?.provider ?? "";
  if (provider === "") return warningHealth("", "provider_missing", "project provider is missing");
  const status = (statuses ?? []).find((item) => cleanString(item.id) === provider);
  if (!statuses || statuses.length === 0) return { provider, status: "configured", warnings: [] };
  if (!status || status.available !== true) return warningHealth(provider, "provider_unavailable", `provider ${provider} unavailable`);
  return {
    available: true,
    capabilities: stringList(status.capabilities),
    provider,
    status: cleanString(status.status) || "available",
    warnings: []
  };
}

export function reportWarnings(
  providerHealth: Record<string, unknown>,
  usageCost: Record<string, unknown>
): ReportWarning[] {
  return [...healthWarnings(providerHealth), ...usageWarnings(usageCost)];
}

function healthWarnings(providerHealth: Record<string, unknown>): ReportWarning[] {
  return warnings(providerHealth).map((item) => ({
    code: cleanString(item.code) || "provider_warning",
    message: cleanString(item.message) || "provider health warning",
    severity: cleanString(item.severity) || "warning",
    source: "provider_health"
  }));
}

function usageWarnings(usageCost: Record<string, unknown>): ReportWarning[] {
  if (cleanString(usageCost.status) === "available") return [];
  return [{
    code: "usage_unavailable",
    message: cleanString(usageCost.error) || "usage data unavailable",
    severity: "warning",
    source: "usage_cost"
  }];
}

function warningHealth(provider: string, code: string, message: string): Record<string, unknown> {
  return { available: false, provider, status: "warning", warnings: [{ code, message, severity: "warning" }] };
}

function warnings(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(value.warnings) ? value.warnings as Array<Record<string, unknown>> : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
