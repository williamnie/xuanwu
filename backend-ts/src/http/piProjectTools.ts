import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions, type PiRunnerActionContext } from "../pi/runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "../pi/runnerActionTools.ts";

export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_ALLOWED_TOOLS = [...PI_READ_ONLY_TOOLS, ...PI_RUNNER_ACTION_TOOL_NAMES] as const;

export function createPiProjectTools(
  db: RunnerDatabase,
  project: Project,
  context: Omit<PiRunnerActionContext, "project"> = {}
): ToolDefinition[] {
  return createPiRunnerActionTools(createPiRunnerActions(db, { ...context, project }));
}
