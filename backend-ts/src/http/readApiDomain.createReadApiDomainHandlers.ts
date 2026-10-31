import { enqueueIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import { createIssueComment, type ListIssueEventsOptions } from "../db/repositories/issueEvents.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { getIssue, listIssueRuns, listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProject, listProjects, type Project, ProjectNotFoundError } from "../db/repositories/projects.ts";
import { requestIssuePiAcceptance } from "../runner/piAcceptanceRequest.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { createAutomaticallyManagedProject, updateAutomaticallyManagedProject } from "../domain/project/automaticTakeover.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import { requestPiAcceptanceCycle } from "../runner/piAcceptanceCoordinator.ts";
import { checkProjectPath } from "./projects/projectPathCheck.ts";
import { cleanString } from "../util/values.ts";
import { OPERATOR_ACTOR, answerHumanReviewAndKickLoop, cancelIssue, createIssueAndKickLoop, deleteIssueWithActor, validateAgentProfileReference, assertExecutorDoesNotOwnLifecycle, recordLifecycleControl, publishIssueStatusChange, shouldKickAfterWrite, kickAutoProject } from "./readApiDomain.assertExecutorDoesNotOwnLifecycle.ts";
import { actionAndKickLoop, listIssueEventsForApi, publicIssues, readIssue, requestHumanReviewWithActor, retryIssueAndKickLoop, publicIssueRuns, isStartIssuePatch, startIssueFromPatch, terminalForSkillAudit, safeAuditSkillIntents } from "./readApiDomain.actionAndKickLoop.ts";
import type { IssueListFilter, IssueMutationActor } from "./readApiDomain.model.ts";

export function createReadApiDomainHandlers(context: ReadApiContext) {
  return {
    auxiliary: {
      listAgentProfiles: () => listAgentProfiles(context.database)
    },
    issues: {
      answerHumanReview: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        answerHumanReviewAndKickLoop(context, id, body, actor)
      ),
      cancel: (id: number, actor = OPERATOR_ACTOR) => cancelIssue(context, id, actor),
      comment: (id: number, body: Record<string, unknown>) => createIssueComment(context.database, id, body),
      create: (body: Record<string, unknown>) => createIssueAndKickLoop(context, body),
      delete: (id: number, actor = OPERATOR_ACTOR) => deleteIssueWithActor(context, id, actor),
      enqueue: (id: number, options: IssueActionOptions, actor = OPERATOR_ACTOR) => (
        actionAndKickLoop(context, enqueueIssue, id, options, actor, "enqueue")
      ),
      events: (id: number, options: ListIssueEventsOptions) => listIssueEventsForApi(context.database, id, options),
      list: (filter: IssueListFilter) => publicIssues(context, listIssues(context.database, filter)),
      read: (id: number) => readIssue(context, id),
      requestHumanReview: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        requestHumanReviewWithActor(context, id, body, actor)
      ),
      retry: (id: number, options: IssueActionOptions, actor = OPERATOR_ACTOR) => (
        retryIssueAndKickLoop(context, id, options, actor)
      ),
      runs: (id: number) => publicIssueRuns(listIssueRuns(context.database, id)),
      update: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        updateIssueAndKickLoop(context, id, body, actor)
      )
    },
    projects: {
      checkPath: (cwd: string | null) => checkProjectPath(context.database, cwd),
      create: (body: Record<string, unknown>) => {
        validateAgentProfileReference(context.database, body, "default_agent_profile_id");
        return createAutomaticallyManagedProject(context.database, body);
      },
      list: () => listProjects(context.database),
      read: (id: string) => mustGetProject(context.database, id),
      update: (id: string, body: Record<string, unknown>) => {
        mustGetProject(context.database, id);
        validateAgentProfileReference(context.database, body, "default_agent_profile_id");
        return updateAutomaticallyManagedProject(context.database, id, body);
      }
    }
  };
}

export async function updateIssueAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>,
  actor: IssueMutationActor
): Promise<Issue> {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  validateAgentProfileReference(context.database, body, "agent_profile_id");
  if (Object.hasOwn(body, "status")) assertExecutorDoesNotOwnLifecycle(context, current, actor, "status_update");
  if (isStartIssuePatch(body)) return startIssueFromPatch(context, id, body, actor);
  const requestedStatus = cleanString(body.status);
  if (requestedStatus === "failed" || requestedStatus === "needs_user") {
    throw new Error(`${requestedStatus} 只能由 PI 语义决策写入`);
  }
  const issue = requestedStatus === "done"
    ? requestIssuePiAcceptance(context.database, id, {
      reason: "Issue PATCH requested done",
      source: "issue-patch-api"
    })
    : updateIssue(context.database, id, body);
  if (Object.hasOwn(body, "status")) recordLifecycleControl(context.database, current, issue, actor, "status_update");
  publishIssueStatusChange(context, issue, body, actor);
  if (
    requestedStatus === "done"
    && issue.status === "in_progress"
    && readIssueDecisionProjection(context.database, issue.id).owner === "pi"
    && context.agenticClient?.decideIssueAcceptance
  ) {
    requestPiAcceptanceCycle({
      database: context.database,
      decideIssueAcceptance: context.agenticClient.decideIssueAcceptance.bind(context.agenticClient),
      issueID: issue.id,
      providers: context.providers,
      source: "issue-done-claim"
    });
  }
  if (terminalForSkillAudit(issue.status)) safeAuditSkillIntents(context.database, issue.id);
  if (shouldKickAfterWrite(issue.status)) kickAutoProject(context, issue.project_id);
  return issue;
}

export function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new ProjectNotFoundError();
  return project;
}
