import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS, PI_READ_ONLY_TOOLS } from "../http/piProjectTools.ts";
import { RUNNER_BUILTIN_PROVIDER_ID } from "./builtinToolRegistry.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";

type ToolContext = Parameters<typeof createPiProjectTools>[2];
type ToolSource = "registry" | "fallback";

export type PiRuntimeToolRegistryAudit = {
  counts: { custom_tools: number; sdk_tools: number; skipped_tools: number };
  custom_tool_names: string[];
  provider_ids: string[];
  registry_error?: string;
  skipped_tool_names: string[];
  source: ToolSource;
  tool_names: string[];
};

export type PiRuntimeToolKit = {
  audit: PiRuntimeToolRegistryAudit;
  customTools: ToolDefinition[];
  source: ToolSource;
  tools: string[];
};

export type PiRuntimeToolAuditInput = {
  conversationID: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  projectID?: string;
};

const READ_ONLY_TOOL_NAMES = new Set<string>(PI_READ_ONLY_TOOLS);

export function createPiRuntimeToolKit(
  db: RunnerDatabase,
  project?: Project,
  context: ToolContext = {}
): PiRuntimeToolKit {
  try {
    return registryToolKit(db, project, context);
  } catch (error) {
    return fallbackToolKit(db, project, context, error);
  }
}

export function recordPiRuntimeToolRegistryAudit(
  db: RunnerDatabase,
  input: PiRuntimeToolAuditInput,
  audit: PiRuntimeToolRegistryAudit
): void {
  try {
    createPiActionEvent(db, {
      action_id: `tool-registry:${input.conversationID || input.heartbeatID || crypto.randomUUID()}`,
      actor: "pi_runtime",
      conversation_id: input.conversationID,
      delegation_id: input.delegationID,
      event_type: "runtime_tool_registry_snapshot",
      heartbeat_id: input.heartbeatID,
      issue_id: input.issueID ?? 0,
      payload_json: JSON.stringify(audit),
      project_id: input.projectID,
      reason: audit.source === "registry" ? "loaded PI runtime tools from registry" : "used PI runtime tool fallback"
    });
  } catch (error) {
    console.warn("[pi-runtime] failed to audit tool registry snapshot:", safeError(error));
  }
}

function registryToolKit(db: RunnerDatabase, project: Project | undefined, context: ToolContext): PiRuntimeToolKit {
  const snapshot = loadAssistantToolRegistrySnapshot(db);
  const provider = snapshot.providers.find((item) => item.id === RUNNER_BUILTIN_PROVIDER_ID);
  if (!provider || provider.status === "disabled") throw new Error("builtin tool provider is unavailable");
  const registryTools = snapshot.tools.filter((tool) => tool.provider_id === RUNNER_BUILTIN_PROVIDER_ID);
  const customTools = createPiProjectTools(db, project, context);
  const customByName = new Map(customTools.map((tool) => [tool.name, tool]));
  const executable = executableToolNames(registryTools.map((tool) => tool.name), customByName);
  if (executable.names.size === 0) throw new Error("builtin tool provider returned no executable tools");
  const tools = PI_ALLOWED_TOOLS.filter((name) => executable.names.has(name));
  const filteredCustomTools = customTools.filter((tool) => executable.names.has(tool.name));
  return {
    audit: auditSnapshot("registry", tools, filteredCustomTools, [provider.id], executable.skipped),
    customTools: filteredCustomTools,
    source: "registry",
    tools
  };
}

function fallbackToolKit(
  db: RunnerDatabase,
  project: Project | undefined,
  context: ToolContext,
  error: unknown
): PiRuntimeToolKit {
  const tools = [...PI_ALLOWED_TOOLS];
  const customTools = createPiProjectTools(db, project, context);
  return {
    audit: {
      ...auditSnapshot("fallback", tools, customTools, ["hardcoded-pi-runtime"], []),
      registry_error: safeError(error)
    },
    customTools,
    source: "fallback",
    tools
  };
}

function executableToolNames(
  names: string[],
  customByName: Map<string, ToolDefinition>
): { names: Set<string>; skipped: string[] } {
  const executable = new Set<string>();
  const skipped: string[] = [];
  for (const name of names) {
    if (READ_ONLY_TOOL_NAMES.has(name) || customByName.has(name)) executable.add(name);
    else skipped.push(name);
  }
  return { names: executable, skipped };
}

function auditSnapshot(
  source: ToolSource,
  tools: string[],
  customTools: ToolDefinition[],
  providerIDs: string[],
  skippedTools: string[]
): PiRuntimeToolRegistryAudit {
  const customToolNames = customTools.map((tool) => tool.name);
  return {
    counts: { custom_tools: customToolNames.length, sdk_tools: tools.length, skipped_tools: skippedTools.length },
    custom_tool_names: customToolNames,
    provider_ids: providerIDs,
    skipped_tool_names: skippedTools,
    source,
    tool_names: tools
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
