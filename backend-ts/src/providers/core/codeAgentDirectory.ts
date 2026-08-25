import { catalogEntryFromRegistry, type ProviderCatalogEntry } from "./catalog.ts";
import type { ProviderRegistry } from "./registry.ts";

export const MANAGED_CODE_AGENT_IDS = ["codex", "claude", "pi-coding-agent", "qoder"] as const;
export type ManagedCodeAgentID = typeof MANAGED_CODE_AGENT_IDS[number];

export function managedCodeAgentCatalog(registry: ProviderRegistry): ProviderCatalogEntry[] {
  return registry.list()
    .filter((entry) => MANAGED_CODE_AGENT_IDS.includes(String(entry.id) as ManagedCodeAgentID))
    .map(catalogEntryFromRegistry);
}
