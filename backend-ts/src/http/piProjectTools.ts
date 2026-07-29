import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "../pi/memoryTools.ts";
import {
  createPiNotificationPreferenceTools,
  PI_NOTIFICATION_PREFERENCE_TOOL_NAMES
} from "../pi/notificationPreferenceTools.ts";
import { createPiRunnerActions, type PiRunnerActionContext } from "../pi/runnerActions.ts";
import { PI_MCP_TOOL_NAMES } from "../pi/mcpToolDefinitions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "../pi/runnerActionTools.ts";
import {
  createPiSupervisorControlTools,
  SUPERVISOR_CONTROL_TOOL_NAMES
} from "../pi/supervisorControlTools.ts";
import {
  createPiLocalWorkspaceTools,
  PI_LOCAL_WORKSPACE_TOOL_NAMES
} from "../pi/localWorkspaceTools.ts";

export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_ALLOWED_TOOLS = [
  ...PI_READ_ONLY_TOOLS,
  ...PI_RUNNER_ACTION_TOOL_NAMES,
  ...SUPERVISOR_CONTROL_TOOL_NAMES,
  ...PI_LOCAL_WORKSPACE_TOOL_NAMES,
  ...PI_MEMORY_TOOL_NAMES,
  ...PI_NOTIFICATION_PREFERENCE_TOOL_NAMES,
  ...PI_MCP_TOOL_NAMES
] as const;

export function createPiProjectTools(
  db: RunnerDatabase,
  project?: Project,
  context: Omit<PiRunnerActionContext, "project"> = {}
): ToolDefinition[] {
  return [
    ...createPiRunnerActionTools(createPiRunnerActions(db, { ...context, project })),
    ...createPiLocalWorkspaceTools(db, project, context),
    ...createPiSupervisorControlTools(db, project, context),
    ...createPiMemoryTools(db, {
      authorization: context.authorization,
      bus: context.bus,
      conversationID: context.conversationID,
      delegationID: context.delegationID,
      heartbeatID: context.heartbeatID,
      projectID: project?.id,
      source: context.source
    }),
    ...createPiNotificationPreferenceTools(db, {
      authorization: context.authorization,
      bus: context.bus,
      conversationID: context.conversationID,
      delegationID: context.delegationID,
      heartbeatID: context.heartbeatID,
      projectID: project?.id,
      source: context.source
    })
  ];
}
