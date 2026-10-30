import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { createProject, type Project } from "../../db/repositories/projects.ts";
import { getIssueAsWork, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { listBuiltinAssistantTools } from "../tools/builtinToolRegistry.ts";
import {
  createPiSupervisorControlTools,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlTools.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const tempRoots: string[] = [];

export async function openFixture(): Promise<{ db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-supervisor-controls-"));
  tempRoots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  const project = createProject(db, {
    auto_run: 0,
    cwd,
    id: "demo",
    name: "Demo",
    provider: "codex"
  });
  return { db, project };
}

export function delegatedAuthorization(projectID: string, actionType: string | string[]) {
  const actionTypes = Array.isArray(actionType) ? actionType : [actionType];
  return {
    allowedActions: actionTypes,
    authorizedActions: actionTypes.map((action_type) => ({ action_type, project_id: projectID })),
    mode: "delegated" as const,
    scope: { project_id: projectID }
  };
}

export function insertRun(db: RunnerDatabase, issueID: number, status: string): string {
  const legacyID = `issue-${issueID}-attempt-1`;
  const startedAt = "2026-07-17T00:00:00.000Z";
  const endedAt = "2026-07-17T00:01:00.000Z";
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
       started_at, ended_at, exit_reason, error)
     values (?, ?, 1, ?, 'codex', '', '', ?, ?, 'provider failed', 'fixture failure')`,
    [legacyID, issueID, status, startedAt, endedAt]
  );
  return `xw:run:issue_runs:${legacyID}`;
}

export function requireTool(tools: ToolLike[], name: string): ToolLike {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

export async function runTool(tools: ToolLike[], name: string, input: Record<string, unknown>) {
  const tool = requireTool(tools, name);
  return await tool.execute(`call-${name}`, input, undefined, undefined, {} as never) as {
    content: Array<{ text?: string; type: string }>;
    details: unknown;
  };
}

export function visibleText(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("");
}

export type ToolLike = {
  execute: (...args: any[]) => unknown;
  name: string;
  parameters: any;
};

export function validateArgs(tool: ToolLike, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}
