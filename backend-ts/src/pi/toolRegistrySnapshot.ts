import type { RunnerDatabase } from "../db/database.ts";
import {
  listStoredAssistantTools,
  listStoredToolProviders
} from "../db/repositories/toolRegistry.ts";
import { listBuiltinAssistantTools, listBuiltinToolProviders } from "./builtinToolRegistry.ts";
import { loadCliConnectorRegistry } from "./cliConnectorProvider.ts";
import { assistantToolKey, type AssistantTool, type ToolProvider } from "./toolProviderEnvelope.ts";

export type AssistantToolRegistrySnapshot = {
  providers: ToolProvider[];
  tools: AssistantTool[];
};

export type AssistantToolRegistrySnapshotOptions = {
  cliConnectorDirs?: string[];
  env?: Record<string, string | undefined>;
};

export function loadAssistantToolRegistrySnapshot(
  db: RunnerDatabase,
  options: AssistantToolRegistrySnapshotOptions = {}
): AssistantToolRegistrySnapshot {
  const cli = loadCliConnectorRegistry({ env: options.env, manifestDirs: options.cliConnectorDirs ?? [] });
  return {
    providers: mergeProviders([...listBuiltinToolProviders(), ...listStoredToolProviders(db), ...cli.providers]),
    tools: mergeTools([...listBuiltinAssistantTools(), ...listStoredAssistantTools(db), ...cli.tools])
  };
}

function mergeProviders(providers: ToolProvider[]): ToolProvider[] {
  return [...new Map(providers.map((provider) => [provider.id, provider])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function mergeTools(tools: AssistantTool[]): AssistantTool[] {
  return [...new Map(tools.map((tool) => [assistantToolKey(tool), tool])).values()]
    .sort((left, right) => assistantToolKey(left).localeCompare(assistantToolKey(right)));
}
