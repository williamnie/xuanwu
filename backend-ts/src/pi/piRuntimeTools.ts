import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS, PI_READ_ONLY_TOOLS } from "../http/piProjectTools.ts";
import { RUNNER_BUILTIN_PROVIDER_ID } from "./builtinToolRegistry.ts";
import { createReadOnlyRuntimeTools } from "./readOnlyRuntimeTools.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";
import type { PiChatToolMode, PiRuntimePromptProfile } from "./runtimePromptProfile.ts";
import { createPiCapabilityTools, PI_CAPABILITY_TOOL_NAMES } from "./capabilityTools.ts";
import {
  assistantToolRuntimePolicy,
  type AssistantTool,
  type PiRuntimeToolProfile,
  type ToolPermission
} from "./toolProviderEnvelope.ts";

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
  surface_mode: string;
  tool_names: string[];
};

export type PiRuntimeToolAuditTarget = {
  permission: ToolPermission | "unknown";
  providerID: string;
};

export type PiRuntimeToolKit = {
  audit: PiRuntimeToolRegistryAudit;
  auditTargets: Record<string, PiRuntimeToolAuditTarget>;
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

export type PiRuntimeToolSelection = {
  chatToolMode?: PiChatToolMode;
  promptProfile: PiRuntimePromptProfile;
};

const READ_ONLY_TOOL_NAMES = new Set<string>(PI_READ_ONLY_TOOLS);

export function createPiRuntimeToolKit(
  db: RunnerDatabase,
  project?: Project,
  context: ToolContext = {},
  selection: PiRuntimeToolSelection = { promptProfile: "chat" }
): PiRuntimeToolKit {
  return registryToolKit(db, project, context, selection);
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
    surface_mode: "unavailable",
    tool_names: []
  };
}

function registryToolKit(
  db: RunnerDatabase,
  project: Project | undefined,
  context: ToolContext,
  selection: PiRuntimeToolSelection
): PiRuntimeToolKit {
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
  const baseCustomTools = [...customTools, ...readOnlyTools.tools];
  const allCustomTools = [
    ...baseCustomTools,
    ...createPiCapabilityTools(db, {
      conversationID: context.conversationID,
      delegationID: context.delegationID,
      heartbeatID: context.heartbeatID,
      issueID: context.issueID,
      projectID: project?.id,
      source: context.source
    }, snapshot, baseCustomTools)
  ];
  const customByName = new Map(allCustomTools.map((tool) => [tool.name, tool]));
  const executable = executableToolNames([
    ...registryTools.map((tool) => tool.name),
    ...readOnlyTools.tools.map((tool) => tool.name),
    ...PI_CAPABILITY_TOOL_NAMES
  ], customByName);
  if (executable.names.size === 0) throw new Error("builtin tool provider returned no executable tools");
  const availableTools = [
    ...PI_ALLOWED_TOOLS.filter((name) => executable.names.has(name)),
    ...readOnlyTools.tools.map((tool) => tool.name).filter((name) => executable.names.has(name))
  ];
  const availableNames = new Set([
    ...availableTools,
    ...allCustomTools.map((tool) => tool.name)
  ]);
  const selectedNames = selectedToolNames(selection, availableNames, snapshot.tools);
  const filteredCustomTools = allCustomTools.filter((tool) => executable.names.has(tool.name) && selectedNames.has(tool.name));
  const tools = [...new Set([
    ...availableTools.filter((name) => selectedNames.has(name)),
    ...filteredCustomTools.map((tool) => tool.name)
  ])];
  return {
    audit: auditSnapshot(
      "registry",
      tools,
      filteredCustomTools,
      [provider.id, ...readOnlyTools.providerIDs],
      executable.skipped,
      surfaceMode(selection)
    ),
    auditTargets: auditTargets(tools, snapshot.tools),
    customTools: filteredCustomTools,
    readOnlyToolNames: readOnlyNames([...tools, ...filteredCustomTools.map((tool) => tool.name)], snapshot.tools),
    source: "registry",
    tools
  };
}

function selectedToolNames(
  selection: PiRuntimeToolSelection,
  available: Set<string>,
  registry: AssistantTool[]
): Set<string> {
  if (selection.promptProfile === "notification") return new Set();
  if (selection.promptProfile === "chat" && selection.chatToolMode === "legacy_full") {
    return new Set(available);
  }
  const profile = runtimeToolProfile(selection);
  const selected = new Set(registry
    .filter((tool) => assistantToolRuntimePolicy(tool).profiles.includes(profile))
    .map((tool) => tool.name)
    .filter((name) => available.has(name)));
  if (selection.promptProfile === "chat" && selection.chatToolMode !== "review") {
    for (const name of PI_CAPABILITY_TOOL_NAMES) if (available.has(name)) selected.add(name);
  }
  return selected;
}

function runtimeToolProfile(selection: PiRuntimeToolSelection): PiRuntimeToolProfile {
  if (selection.promptProfile === "chat") return selection.chatToolMode === "review" ? "review" : "chat";
  if (selection.promptProfile === "notification") throw new Error("notification profile has no runtime tools");
  return selection.promptProfile;
}

function surfaceMode(selection: PiRuntimeToolSelection): string {
  if (selection.promptProfile !== "chat") return selection.promptProfile;
  if (selection.chatToolMode === "review") return "review";
  return selection.chatToolMode === "legacy_full" ? "legacy_full" : "bootstrap_v2";
}

function auditTargets(names: string[], registry: AssistantTool[]): Record<string, PiRuntimeToolAuditTarget> {
  const targets: Record<string, PiRuntimeToolAuditTarget> = {};
  for (const name of names) {
    if (PI_CAPABILITY_TOOL_NAMES.includes(name as never)) {
      targets[name] = {
        permission: name === "capability_invoke" ? "unknown" : "read",
        providerID: "xuanwu-runtime"
      };
      continue;
    }
    const matches = registry.filter((tool) => tool.name === name);
    const target = matches.find((tool) => tool.provider_id === RUNNER_BUILTIN_PROVIDER_ID) ?? matches[0];
    targets[name] = target
      ? { permission: target.permission, providerID: target.provider_id }
      : { permission: "unknown", providerID: RUNNER_BUILTIN_PROVIDER_ID };
  }
  return targets;
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
  skippedTools: string[],
  surfaceModeValue: string
): PiRuntimeToolRegistryAudit {
  const customToolNames = customTools.map((tool) => tool.name);
  return {
    counts: { custom_tools: customToolNames.length, sdk_tools: tools.length, skipped_tools: skippedTools.length },
    custom_tool_names: customToolNames,
    provider_ids: providerIDs,
    skipped_tool_names: skippedTools,
    source,
    status: "ready",
    surface_mode: surfaceModeValue,
    tool_names: tools
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
