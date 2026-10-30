import type { RunnerDatabase } from "../../db/database.ts";
import { deleteIssues } from "../../db/repositories/issueActions.ts";
import { createPendingPiAction, executeSafePiAction } from "../actions/actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { humanReviewExpectedState, issueBatchExpectedState } from "../actions/actionFreshness.ts";
import { executeIssueStatusUpdate, prepareIssueStatusUpdate, type IssueStatusUpdateInput } from "./runnerIssueStatusActions.ts";
import { readIssueDecisionProjection, reviewHumanIssue } from "../../domain/review/humanReview.ts";
import { readRunnerSettings, updateRunnerSettings as applyRunnerSettings } from "../../http/settings/runnerSettingsApi.ts";
import { scheduleSystemRestart } from "../../http/system/systemRestartApi.ts";
import { cleanString } from "../../util/values.ts";
import { PiRunnerActionContext, IssueCancelInput, HumanReviewResponseInput, IssueDeleteInput, RunnerSettingsUpdateInput, SystemRestartInput } from "./runnerActionInputs.ts";
import { issueStatusRuntime } from "./runnerCompletionActions.ts";
import { cleanObjectPayload, mustGetIssue, explicitIssues, singleProjectID, runnerSettingsContext, systemRestartContext } from "./runnerActionValues.ts";

export function cancelIssues(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCancelInput
) {
  const reason = cleanString(input.rationale) || "用户明确取消 Issue";
  const statusInput: IssueStatusUpdateInput = { issue_ids: input.issue_ids, reason, status: "cancelled" };
  const prepared = prepareIssueStatusUpdate(db, statusInput);
  const projectID = prepared.projectID;
  const actionType = "issue.cancel";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueIDs: prepared.issues.map((issue) => issue.id),
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    payload: {
      expected_state: issueBatchExpectedState(prepared.issues),
      issue_ids: prepared.issues.map((issue) => issue.id),
      reason,
      status: "cancelled"
    },
    projectID,
    rationale: input.rationale
  }, () => executeIssueStatusUpdate(db, statusInput, issueStatusRuntime(context)));
}

export function updateIssueStatuses(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueStatusUpdateInput
) {
  const prepared = prepareIssueStatusUpdate(db, input);
  const actionType = "issue.status_update";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueIDs: prepared.issues.map((issue) => issue.id),
    projectID: prepared.projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    payload: {
      ...cleanObjectPayload(input),
      expected_state: issueBatchExpectedState(prepared.issues)
    },
    projectID: prepared.projectID,
    rationale: input.reason
  }, () => executeIssueStatusUpdate(db, input, issueStatusRuntime(context)));
}

export function respondToHumanReview(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: HumanReviewResponseInput
) {
  const issue = mustGetIssue(db, input.issue_id);
  const actionType = "human_review.respond";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issue.id,
    projectID: issue.project_id
  });
  const currentReview = readIssueDecisionProjection(db, issue.id).request;
  const payload = {
    ...cleanObjectPayload(input),
    expected_state: humanReviewExpectedState(issue, currentReview)
  };
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issue.id,
    payload,
    projectID: issue.project_id,
    rationale: cleanString(input.comment) || `human review ${input.action}`
  }, async () => {
    const updated = await reviewHumanIssue(db, issue.id, payload, {
      bus: context.bus,
      providers: context.providers
    });
    return {
      action: input.action,
      decision: readIssueDecisionProjection(db, issue.id),
      issue: {
        id: updated.id,
        project_id: updated.project_id,
        status: updated.status,
        title: updated.title
      }
    };
  });
}

export function deleteIssuesProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueDeleteInput
) {
  const issues = explicitIssues(db, input.issue_ids);
  const projectID = singleProjectID(issues.map((issue) => issue.project_id));
  const actionType = "issue.delete";
  const actionContext = scopedRunnerChatActionContext(context, actionType, {
    issueID: issues.length === 1 ? issues[0]?.id : undefined,
    issueIDs: issues.map((issue) => issue.id),
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType,
    issueID: issues.length === 1 ? issues[0]?.id : undefined,
    payload: {
      expected_state: issueBatchExpectedState(issues),
      issue_ids: issues.map((issue) => issue.id),
      reason: input.reason
    },
    projectID,
    rationale: input.reason
  }, () => deleteIssues(db, issues.map((issue) => issue.id)));
}

export function safeReadRunnerSettings(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "runner.settings_read",
    payload: {},
    execute: () => readRunnerSettings(runnerSettingsContext(db, context))
  });
}

export function runnerSettingsUpdateProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: RunnerSettingsUpdateInput
) {
  const payload = cleanObjectPayload(input);
  return createPendingPiAction(db, context, {
    actionType: "runner.settings_update",
    payload,
    rationale: input.reason
  }, () => applyRunnerSettings(runnerSettingsContext(db, context), payload));
}

export function restartSystemProposal(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: SystemRestartInput
) {
  return createPendingPiAction(db, context, {
    actionType: "system.restart",
    payload: { reason: input.reason },
    rationale: input.reason
  }, () => {
    const result = scheduleSystemRestart(systemRestartContext(context));
    if (!result) throw new Error("当前服务不是 launchd/systemd 托管，无法安全重启");
    return result;
  });
}
