import type { RunnerDatabase } from "../db/database.ts";
import {
  listStoredAssistantTools,
  listStoredToolProviders
} from "../db/repositories/toolRegistry.ts";
import { listBuiltinAssistantTools, listBuiltinToolProviders } from "./builtinToolRegistry.ts";
import { assistantToolKey, type AssistantTool, type ToolProvider } from "./toolProviderEnvelope.ts";

export type AssistantToolRegistrySnapshot = {
  providers: ToolProvider[];
  tools: AssistantTool[];
};

export function loadAssistantToolRegistrySnapshot(db: RunnerDatabase): AssistantToolRegistrySnapshot {
  return {
    providers: mergeProviders([...listBuiltinToolProviders(), ...listStoredToolProviders(db)]),
    tools: mergeTools([...listBuiltinAssistantTools(), ...listStoredAssistantTools(db)])
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
