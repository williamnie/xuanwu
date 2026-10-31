import type { RunnerDatabase } from "../../db/database.ts";
import { deleteIssues } from "../../db/repositories/issueActions.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createIssueComment } from "../../db/repositories/issueEvents.ts";
import { listProjects } from "../../db/repositories/projects.ts";
import { createPiMcpActions } from "../mcp/mcpActionTools.ts";
import { createPendingPiAction, executeSafePiAction } from "../actions/actionEngine.ts";
import { createIssueStateRepairProposal, safeIssueStateDiagnosis } from "./runnerIssueStateActions.ts";
import { createIssueScheduleEnqueueAction } from "./runnerIssueScheduleActions.ts";
import { createPiAgentOrchestrationActions } from "../runtime/agentOrchestrationActions.ts";
import { createPiRepoReadActions } from "../tools/repoReadActionTools.ts";
import { createBatchTriageEnqueueAction, createNextTriageEnqueueAction } from "./runnerNextTriageActions.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { issueEnqueueExpectedState } from "../actions/actionFreshness.ts";
import { materializeIssueBatch } from "./issueBatchProposal.ts";
import { createHumanReviewRequest as createHumanReviewRequestRecord } from "../../domain/review/humanReview.ts";
import { readRunnerSettings } from "../../http/settings/runnerSettingsApi.ts";
import { PiRunnerActionContext, PiRunnerActionLayer } from "./runnerActionInputs.ts";
import { respondToHumanReview, cancelIssues, deleteIssuesProposal, updateIssueStatuses, safeReadRunnerSettings, restartSystemProposal, runnerSettingsUpdateProposal } from "./runnerIssueMutations.ts";
import { actionContextForProposal, enqueueIssueAndNotify, createCompletionWatch, safeListCompletionWatches, cancelCompletionWatch, manualContextIntake } from "./runnerCompletionActions.ts";
import { requestIssueAcceptanceAction, safeIssueExecutionStatus, safeIssueStatusSummary, safeListIssues, safeListSessions, safeProjectStatus, safeReadIssue, safeReadSessionSummary } from "./runnerIssueQueries.ts";
import { issueCreateProposal, issueCreateBatchProposal, sessionSteerProposal, safeSkillIntentAudit, safeListSkills, safeReadSkill, safeRecommendSkills } from "./runnerProposalActions.ts";
import { issueProjectID, cleanObjectPayload, mustGetIssue, readSessionSummary } from "./runnerActionValues.ts";

export function createPiRunnerActions(
  db: RunnerDatabase,
  context: PiRunnerActionContext = {}
): PiRunnerActionLayer {
  return {
    ...createPiAgentOrchestrationActions(db, context),
    ...createPiMcpActions(db, { ...context, projectID: context.project?.id }),
    ...createPiRepoReadActions(db, context),
    commentIssue: (input) => executeSafePiAction(db, scopedRunnerChatActionContext(context, "issue.comment", { issueID: input.issue_id }), {
      actionType: "issue.comment",
      issueID: input.issue_id,
      payload: { body: input.body, issue_id: input.issue_id },
      projectID: issueProjectID(db, input.issue_id, context),
      execute: () => createIssueComment(db, input.issue_id, { author: "agent", body: input.body })
    }),
    createHumanReviewRequest: (input) => executeSafePiAction(db, scopedRunnerChatActionContext(context, "human_review.request", { issueID: input.issue_id }), {
      actionType: "human_review.request",
      issueID: input.issue_id,
      payload: cleanObjectPayload(input),
      projectID: issueProjectID(db, input.issue_id, context),
      execute: () => createHumanReviewRequestRecord(db, input.issue_id, input, { bus: context.bus })
    }),
    respondToHumanReview: (input) => respondToHumanReview(db, context, input),
    cancelIssues: (input) => cancelIssues(db, context, input),
    deleteIssues: (input) => deleteIssuesProposal(db, context, input),
    updateIssueStatuses: (input) => updateIssueStatuses(db, context, input),
    createIssueProposal: (input) => {
      const proposal = issueCreateProposal(input, context);
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => createIssue(db, proposal.payload));
    },
    createIssueBatchProposal: (input) => {
      const proposal = issueCreateBatchProposal(input, context);
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => materializeIssueBatch(db, proposal.payload));
    },
    createIssueStateRepairProposal: (input) => createIssueStateRepairProposal(db, context, input),
    diagnoseIssueState: (input) => safeIssueStateDiagnosis(db, context, input),
    createSessionSteerProposal: (input) => createPendingPiAction(db, context, sessionSteerProposal(db, input)),
    auditSkillIntents: (input) => safeSkillIntentAudit(db, context, input),
    enqueueIssueProposal: (input) => {
      const issue = mustGetIssue(db, input.issue_id);
      const proposal = {
        actionType: "issue.enqueue",
        issueID: input.issue_id,
        payload: {
          issue_id: input.issue_id,
          expected_state: issueEnqueueExpectedState(issue)
        },
        projectID: issue.project_id || (context.project?.id ?? ""),
        rationale: input.rationale
      };
      const actionContext = actionContextForProposal(context, proposal);
      return createPendingPiAction(db, actionContext, proposal, () => enqueueIssueAndNotify(db, context, input.issue_id));
    },
    requestIssueAcceptanceAction: (input) => requestIssueAcceptanceAction(db, context, input),
    enqueueBatchTriageIssues: (input) => createBatchTriageEnqueueAction(db, context, input),
    enqueueNextTriageIssue: (input) => createNextTriageEnqueueAction(db, context, input),
    createIssueCompletionWatch: (input) => createCompletionWatch(db, context, input),
    listIssueCompletionWatches: (input) => safeListCompletionWatches(db, context, input),
    cancelIssueCompletionWatch: (input) => cancelCompletionWatch(db, context, input),
    scheduleIssueEnqueue: (input) => createIssueScheduleEnqueueAction(db, context, input),
    issueExecutionStatus: (input) => safeIssueExecutionStatus(db, context, input),
    issueStatusSummary: (input) => safeIssueStatusSummary(db, context, input),
    runManualContextIntake: (input) => manualContextIntake(db, context, input),
    listIssues: (input) => safeListIssues(db, context, input),
    listSkills: () => safeListSkills(db, context),
    listProjects: () => executeSafePiAction(db, context, {
      actionType: "project.list",
      payload: {},
      execute: () => ({ items: listProjects(db) })
    }),
    listSessions: (input) => safeListSessions(db, context, input),
    projectStatus: (input) => safeProjectStatus(db, context, input),
    readSkill: (input) => safeReadSkill(db, context, input),
    recommendSkills: (input) => safeRecommendSkills(db, context, input),
    readIssue: (input) => safeReadIssue(db, context, input),
    readRunnerSettings: () => safeReadRunnerSettings(db, context),
    readSessionSummary: (input) => safeReadSessionSummary(db, context, input),
    restartSystem: (input) => restartSystemProposal(db, context, input),
    updateRunnerSettings: (input) => runnerSettingsUpdateProposal(db, context, input)
  };
}

export { type PiRunnerActionLayer, type PiRunnerActionContext } from "./runnerActionInputs.ts";
