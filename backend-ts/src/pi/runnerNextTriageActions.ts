import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { createPendingPiAction, type PiActionContext } from "./actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";

export type NextTriageIssueInput = { project_id?: string; rationale?: string };

type NextTriageContext = PiActionContext & {
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
};

export function createNextTriageEnqueueAction(
  db: RunnerDatabase,
  context: NextTriageContext,
  input: NextTriageIssueInput
): unknown {
  const projectID = scopedProjectID(input.project_id, context);
  const issue = nextTriageIssue(db, projectID);
  if (!issue) return noNextTriageCandidate(projectID);
  const actionContext = scopedRunnerChatActionContext(context, "issue.enqueue", {
    issueID: issue.id,
    projectID: issue.project_id
  });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue.enqueue",
    issueID: issue.id,
    payload: { issue_id: issue.id },
    projectID: issue.project_id,
    rationale: input.rationale
  }, () => enqueueIssueAndNotify(db, context, issue.id));
}

function nextTriageIssue(db: RunnerDatabase, projectID: string): Issue | undefined {
  return listIssues(db, { projectId: projectID, status: "triage" })
    .sort(nextTriageIssueOrder)[0];
}

function nextTriageIssueOrder(left: Issue, right: Issue): number {
  return (right.priority - left.priority) ||
    left.created_at.localeCompare(right.created_at) ||
    (left.id - right.id);
}

function enqueueIssueAndNotify(
  db: RunnerDatabase,
  context: NextTriageContext,
  issueID: number
): Record<string, number | string> {
  const issue = enqueueIssue(db, issueID);
  context.onIssueEnqueued?.(issue.project_id);
  return compactEnqueuedIssue(issue);
}

function compactEnqueuedIssue(issue: Issue): Record<string, number | string> {
  return {
    id: issue.id,
    message: `enqueued issue #${issue.id}: ${issue.title}`,
    project_id: issue.project_id,
    status: issue.status,
    title: issue.title
  };
}

function noNextTriageCandidate(projectID: string) {
  return {
    message: "没有可继续的 triage issue",
    project_id: projectID,
    source: "issue_enqueue_next_triage",
    status: "no_candidate"
  };
}

function scopedProjectID(id: unknown, context: NextTriageContext): string {
  const projectID = cleanString(id) || (context.project?.id ?? "");
  if (projectID === "") throw new ProjectNotFoundError();
  return projectID;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
