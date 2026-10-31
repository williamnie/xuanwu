import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import { ProjectNotFoundError } from "../../db/repositories/projects.ts";
import { getAgentSessionByReference } from "../../db/repositories/agentSessions.ts";
import { observeSessionProgress } from "./sessionObserver.ts";
import { cleanString } from "../../util/values.ts";
import { IssueListInput, PiRunnerActionContext, IssueQueryScope, SessionListInput } from "./runnerActionInputs.ts";

export function normalizeIssueFilter(input: IssueListInput, context: PiRunnerActionContext) {
  const explicitProjectID = cleanString(input.project_id);
  const requestedScope = cleanString(input.scope);
  if (requestedScope !== "" && requestedScope !== "global" && requestedScope !== "project") {
    throw new Error("scope must be global or project");
  }
  if (requestedScope === "global" && explicitProjectID !== "") {
    throw new Error("project_id must be empty when scope is global");
  }
  const defaultScope = context.issueQueryDefaultScope ?? (context.project?.id ? "project" : "global");
  const scope: IssueQueryScope = requestedScope === "global" || requestedScope === "project"
    ? requestedScope
    : explicitProjectID !== "" ? "project" : defaultScope;
  const projectId = scope === "project" ? explicitProjectID || (context.project?.id ?? "") : "";
  if (scope === "project" && projectId === "") throw new ProjectNotFoundError();
  return {
    projectId,
    scope,
    scopeSource: requestedScope !== ""
      ? "explicit_scope"
      : explicitProjectID !== "" ? "explicit_project_id" : "runtime_default",
    status: cleanString(input.status),
    sourceSessionId: ""
  };
}

export function normalizeSessionFilter(input: SessionListInput, context: PiRunnerActionContext) {
  return {
    projectId: cleanString(input.project_id) || (context.project?.id ?? ""),
    provider: cleanString(input.provider),
    role: cleanString(input.role)
  };
}

export function requiredCreateProjectID(id: unknown): string {
  const projectID = cleanString(id);
  if (projectID === "") {
    throw new Error("issue_create_project_required: 创建 Issue 需要 project_id，但当前工具输入未提供目标 Project 信息");
  }
  return projectID;
}

export function issueProjectID(db: RunnerDatabase, id: number, context: PiRunnerActionContext): string {
  return mustGetIssue(db, id).project_id || (context.project?.id ?? "");
}

export function mustGetIssue(db: RunnerDatabase, id: number) {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

export function explicitIssues(db: RunnerDatabase, ids: number[]): Issue[] {
  const uniqueIDs = [...new Set(ids)];
  if (uniqueIDs.length === 0 || uniqueIDs.length > 40) throw new Error("issue_ids must contain 1-40 items");
  return uniqueIDs.map((id) => mustGetIssue(db, id));
}

export function singleProjectID(projectIDs: string[]): string {
  const unique = [...new Set(projectIDs.filter(Boolean))];
  if (unique.length !== 1) throw new Error("批量 Issue 操作必须属于同一个项目");
  return unique[0]!;
}

export function runnerSettingsContext(db: RunnerDatabase, context: PiRunnerActionContext) {
  return {
    bus: context.bus,
    config: context.config,
    database: db,
    providers: context.providers
  };
}

export function systemRestartContext(context: PiRunnerActionContext) {
  return {
    audit: context.auditSystemRestart,
    providers: context.providers,
    restartDelayMs: context.restartDelayMs,
    restartProcess: context.restartProcess,
    supervisorManaged: context.supervisorManaged
  };
}

export function readSessionSummary(db: RunnerDatabase, sessionKey: string) {
  const key = cleanString(sessionKey);
  const session = getAgentSessionByReference(db, key);
  if (!session) throw new Error("session 不存在");
  return {
    agent_role: session.agent_role,
    issue_id: session.issue_id,
    preview: session.preview,
    progress: observeSessionProgress(db, key),
    project_id: session.project_id,
    provider: session.provider,
    provider_session_id: session.provider_session_id,
    session_key: session.session_key,
    status: session.status,
    title: session.title,
    updated_at: session.updated_at
  };
}

export function cleanObject(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "")) as Record<string, string>;
}

export function cleanObjectPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
  )));
}
