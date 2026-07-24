import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS, PI_READ_ONLY_TOOLS } from "../http/piProjectTools.ts";
import { RUNNER_BUILTIN_PROVIDER_ID } from "./builtinToolRegistry.ts";
import { createReadOnlyRuntimeTools } from "./readOnlyRuntimeTools.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";

type ToolContext = NonNullable<Parameters<typeof createPiProjectTools>[2]>;
type ToolSource = "registry";

export type PiRuntimeToolRegistryAudit = {
  counts: { custom_tools: number; sdk_tools: number; skipped_tools: number };
  custom_tool_names: string[];
  provider_ids: string[];
  registry_error?: string;
  skipped_tool_names: string[];
  source: ToolSource;
  status: "ready" | "unavailable";
  tool_names: string[];
};

export type PiRuntimeToolKit = {
  audit: PiRuntimeToolRegistryAudit;
  customTools: ToolDefinition[];
  readOnlyToolNames: string[];
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
  return registryToolKit(db, project, context);
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
      reason: audit.status === "ready"
        ? "loaded PI runtime tools from registry"
        : "PI runtime tool registry is unavailable; no fallback tools were installed"
    });
  } catch (error) {
    console.warn("[pi-runtime] failed to audit tool registry snapshot:", safeError(error));
  }
}

export function unavailablePiRuntimeToolRegistryAudit(error: unknown): PiRuntimeToolRegistryAudit {
  return {
    counts: { custom_tools: 0, sdk_tools: 0, skipped_tools: 0 },
    custom_tool_names: [],
    provider_ids: [],
    registry_error: safeError(error),
    skipped_tool_names: [],
    source: "registry",
    status: "unavailable",
    tool_names: []
  };
}

function registryToolKit(db: RunnerDatabase, project: Project | undefined, context: ToolContext): PiRuntimeToolKit {
  const snapshot = loadAssistantToolRegistrySnapshot(db);
  const provider = snapshot.providers.find((item) => item.id === RUNNER_BUILTIN_PROVIDER_ID);
  if (!provider || provider.status === "disabled") throw new Error("builtin tool provider is unavailable");
  const registryTools = snapshot.tools.filter((tool) => tool.provider_id === RUNNER_BUILTIN_PROVIDER_ID);
  const customTools = createPiProjectTools(db, project, context);
  const readOnlyTools = createReadOnlyRuntimeTools({
    context,
    db,
    existingNames: new Set(customTools.map((tool) => tool.name)),
    projectID: project?.id,
    providers: snapshot.providers,
    tools: snapshot.tools
  });
  const allCustomTools = [...customTools, ...readOnlyTools.tools];
  const customByName = new Map(allCustomTools.map((tool) => [tool.name, tool]));
  const executable = executableToolNames([
    ...registryTools.map((tool) => tool.name),
    ...readOnlyTools.tools.map((tool) => tool.name)
  ], customByName);
  if (executable.names.size === 0) throw new Error("builtin tool provider returned no executable tools");
  const tools = [
    ...PI_ALLOWED_TOOLS.filter((name) => executable.names.has(name)),
    ...readOnlyTools.tools.map((tool) => tool.name).filter((name) => executable.names.has(name))
  ];
  const filteredCustomTools = allCustomTools.filter((tool) => executable.names.has(tool.name));
  return {
    audit: auditSnapshot("registry", tools, filteredCustomTools, [provider.id, ...readOnlyTools.providerIDs], executable.skipped),
    customTools: filteredCustomTools,
    readOnlyToolNames: readOnlyNames([...tools, ...filteredCustomTools.map((tool) => tool.name)], snapshot.tools),
    source: "registry",
    tools
  };
}

function readOnlyNames(names: string[], registry: ReturnType<typeof loadAssistantToolRegistrySnapshot>["tools"]): string[] {
  return [...new Set(names)].filter((name) => {
    const matches = registry.filter((tool) => tool.name === name);
    return matches.length > 0 && matches.every((tool) => tool.permission === "read");
  });
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
    status: "ready",
    tool_names: tools
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
