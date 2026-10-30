import type { RunnerDatabase } from "../../db/database.ts";
import { listProjects, type Project } from "../../db/repositories/projects.ts";
import { listAgentSessions } from "../../db/repositories/agentSessions.ts";
import { createPendingPiAction, executeSafePiAction } from "../actions/actionEngine.ts";
import { createProjectStatusSnapshot } from "../reports/projectSnapshot.ts";
import { createCompactIssueList, createIssueExecutionStatus, createIssueStatusSummary } from "./issueToolViews.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { requestIssuePiAcceptance } from "../../runner/piAcceptanceRequest.ts";
import { readIssueDependency } from "../../domain/work/issueDependency.ts";
import { allowedIssueStatusTargets } from "./runnerIssueStatusActions.ts";
import { readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { cleanString } from "../../util/values.ts";
import { PiRunnerActionContext, IssueAcceptanceRequestInput, IssueListInput, IssueStatusSummaryInput, IssueExecutionStatusInput, SessionListInput, ProjectStatusInput, IssueReadInput, SessionReadSummaryInput } from "./runnerActionInputs.ts";
import { mustGetIssue, normalizeIssueFilter, cleanObjectPayload, cleanObject, normalizeSessionFilter, readSessionSummary } from "./runnerActionValues.ts";

export function requestIssueAcceptanceAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueAcceptanceRequestInput
) {
  const issue = mustGetIssue(db, input.issue_id);
  const actionType = "issue.acceptance_request";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issue.id,
    projectID: issue.project_id
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issue.id,
    payload: { issue_id: issue.id, rationale: cleanString(input.rationale) },
    projectID: issue.project_id,
    rationale: input.rationale
  }, async () => {
    const pending = requestIssuePiAcceptance(db, issue.id, {
      reason: input.rationale,
      source: "pi-issue-completion-reconciliation"
    });
    return {
      issue: {
        id: pending.id,
        project_id: pending.project_id,
        status: pending.status,
        title: pending.title
      },
      target_status: pending.status,
      transition_path: []
    };
  });
}

export function safeListIssues(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueListInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.list",
    payload: cleanObjectPayload({
      limit: input.limit,
      project_id: filter.projectId,
      scope: filter.scope,
      scope_source: filter.scopeSource,
      status: filter.status
    }),
    projectID: filter.projectId,
    execute: () => createCompactIssueList(db, {
      limit: input.limit,
      projectId: filter.projectId,
      scope: filter.scope,
      scopeSource: filter.scopeSource,
      status: filter.status
    })
  });
}

export function safeIssueStatusSummary(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueStatusSummaryInput) {
  const filter = normalizeIssueFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "issue.status_summary",
    payload: cleanObject({
      project_id: filter.projectId,
      scope: filter.scope,
      scope_source: filter.scopeSource,
      status: filter.status
    }),
    projectID: filter.projectId,
    execute: () => createIssueStatusSummary(db, {
      projectId: filter.projectId,
      scope: filter.scope,
      scopeSource: filter.scopeSource,
      status: filter.status
    })
  });
}

export function safeIssueExecutionStatus(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueExecutionStatusInput) {
  const issue = mustGetIssue(db, input.id);
  return executeSafePiAction(db, context, {
    actionType: "issue.execution_status",
    issueID: issue.id,
    payload: { id: issue.id },
    projectID: issue.project_id,
    execute: () => createIssueExecutionStatus(db, issue.id)
  });
}

export function safeListSessions(db: RunnerDatabase, context: PiRunnerActionContext, input: SessionListInput) {
  const filter = normalizeSessionFilter(input, context);
  return executeSafePiAction(db, context, {
    actionType: "session.list",
    payload: cleanObject({ project_id: filter.projectId, provider: filter.provider, role: filter.role }),
    projectID: filter.projectId,
    execute: () => ({ items: listAgentSessions(db, filter) })
  });
}

export function safeProjectStatus(db: RunnerDatabase, context: PiRunnerActionContext, input: ProjectStatusInput) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  if (projectID === "") return safeGlobalProjectStatus(db, context);
  return executeSafePiAction(db, context, {
    actionType: "project.status",
    payload: { project_id: projectID },
    projectID,
    execute: () => createProjectStatusSnapshot(db, projectID)
  });
}

export function safeGlobalProjectStatus(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "project.status",
    payload: {},
    execute: () => ({ items: listProjects(db).map(projectStatusSummary) })
  });
}

export function projectStatusSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    provider: project.provider,
    status: project.hold?.reason ? `hold:${project.hold.reason}` : "active"
  };
}

export function safeReadIssue(db: RunnerDatabase, context: PiRunnerActionContext, input: IssueReadInput) {
  const issue = mustGetIssue(db, input.id);
  return executeSafePiAction(db, context, {
    actionType: "issue.read",
    issueID: issue.id,
    payload: { id: issue.id },
    projectID: issue.project_id,
    execute: () => ({
      ...issue,
      allowed_status_targets: allowedIssueStatusTargets(issue.status),
      decision: readIssueDecisionProjection(db, issue.id),
      dependency: readIssueDependency(db, issue.id),
      execution: createIssueExecutionStatus(db, issue.id),
      source: "issue_read"
    })
  });
}

export function safeReadSessionSummary(db: RunnerDatabase, context: PiRunnerActionContext, input: SessionReadSummaryInput) {
  const session = readSessionSummary(db, input.session_key);
  return executeSafePiAction(db, context, {
    actionType: "session.read_summary",
    payload: { session_key: session.session_key },
    projectID: session.project_id,
    execute: () => session
  });
}
