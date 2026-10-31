import type { RunnerDatabase } from "../../db/database.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import {
  insertIssueRunRecord,
  mustGetCurrentOpenIssueRun,
  updateIssueRuntime
} from "../../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../run/runPreparation.ts";
import { listIssueRuns, type Issue } from "../../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError } from "../../db/repositories/projects.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { isExecutorProviderId } from "../../providers/types.ts";
import { requestIssuePiAcceptance } from "../../runner/piAcceptanceRequest.ts";
import {
  assertWorkspaceReacquisition,
  commitWorkspaceReacquisition,
  type WorkspaceReacquisition
} from "./workspaceWait.ts";
import { cleanString, errorMessage } from "../../util/values.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import {
  type HumanReviewRequest,
  type HumanReviewRuntime,
  HUMAN_REVIEW_EVENT_TYPES,
  revisionPrompt,
  requiredText,
  mustGetIssue,
  HumanReviewConflictError,
  positiveInteger
} from "./humanReviewModel.ts";
import { readIssueDecisionProjection } from "./humanReviewProjection.ts";

export async function resumeRevisionInSameSession(
  db: RunnerDatabase,
  issue: Issue,
  request: HumanReviewRequest,
  feedback: string,
  runtime: HumanReviewRuntime,
  workspace: WorkspaceReacquisition | null
): Promise<Issue> {
  const previousRun = listIssueRuns(db, issue.id)
    .filter((run) => cleanString(run.provider_session_id) !== "")
    .at(-1);
  if (!previousRun) throw new Error("无法继续原 Session：未找到带 provider_session_id 的历史 Run");
  const providerID = cleanString(previousRun.provider);
  if (!isExecutorProviderId(providerID)) throw new Error(`无法继续原 Session：provider "${providerID}" 不受支持`);
  const provider = providersForProjectID(db, runtime.providers, issue.project_id)?.[providerID];
  if (!provider?.sendSessionMessage || !provider.capabilities.includes("resume_session")) {
    throw new Error(`provider "${providerID}" 不支持在原 Session 中继续调整`);
  }
  const project = getProject(db, issue.project_id);
  if (!project) throw new ProjectNotFoundError();

  const prepare = db.transaction(() => {
    requireCurrentReviewRequest(db, issue.id, { review_request_id: request.id, review_revision: request.revision });
    assertWorkspaceReacquisition(db, issue.id, request, workspace);
    recordIssueEvent(db, issue.id, "issue.comment", {
      author: "user",
      body: feedback,
      source: "human_review_request_changes"
    });
    updateIssue(db, issue.id, { error: "", status: "in_progress" });
    commitWorkspaceReacquisition(db, issue.id, workspace);
    const run = insertIssueRunRecord(db, issue.id, { provider: providerID });
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionRequested, {
      feedback,
      new_run_id: run.run_id,
      provider: providerID,
      provider_session_id: previousRun.provider_session_id,
      request_id: request.id,
      revision: request.revision,
      resumed_from_run_id: previousRun.id,
      status: "executing"
    });
    return run;
  });
  const reservation = prepare.immediate();
  const preparation = await prepareReservedIssueRun(db, reservation);
  if (preparation.status !== "ready") throw new Error("Run preparation claim was invalidated before Session resume");
  const run = preparation.run;
  try {
    mustGetCurrentOpenIssueRun(db, issue.id, run.id);
    const result = await provider.sendSessionMessage({
      cwd: project.cwd,
      prompt: revisionPrompt(issue, request, feedback),
      projectId: project.id,
      sessionId: previousRun.provider_session_id
    });
    const sessionID = cleanString(result.provider_session_id)
      || cleanString(result.sessionId)
      || previousRun.provider_session_id;
    const turnID = requiredText(result.turn_id, "provider turn id");
    updateIssueRuntime(db, issue.id, {
      issue_run_id: run.id,
      provider: providerID,
      provider_session_id: sessionID,
      provider_turn_id: turnID,
      metadata: {
        human_review_request_id: request.id,
        human_review_revision: request.revision,
        resumed_from_run_id: previousRun.id,
        revision_source: "human_review"
      }
    });
    upsertAgentSession(db, {
      issue_id: issue.id,
      project_id: project.id,
      provider: providerID,
      provider_session_id: sessionID,
      raw_ref: { provider_turn_id: turnID },
      status: "running",
      title: issue.title
    });
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionResumed, {
      feedback,
      new_run_id: run.id,
      provider: providerID,
      provider_session_id: sessionID,
      provider_turn_id: turnID,
      request_id: request.id,
      revision: request.revision,
      resumed_from_run_id: previousRun.id
    });
    recordIssueEvent(db, issue.id, "issue.human_review_response_applied.v1", {
      action: "request_changes",
      comment: feedback,
      request_id: request.id,
      revision: request.revision,
      status: "in_progress"
    });
    recordIssueEvent(db, issue.id, "issue.status_changed", {
      reason: "human_requested_changes",
      status: "in_progress"
    });
    runtime.bus?.publish({
      issueId: issue.id,
      projectId: issue.project_id,
      status: "in_progress",
      type: "issue.status_changed"
    });
    return mustGetIssue(db, issue.id);
  } catch (error) {
    const now = new Date().toISOString();
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at=?, exit_reason='human_revision_resume_failed', error=? where id=?",
      [now, errorMessage(error), run.id]
    );
    recordIssueEvent(db, issue.id, HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed, {
      error: errorMessage(error),
      request_id: request.id,
      revision: request.revision,
      run_id: run.id
    });
    requestIssuePiAcceptance(db, issue.id, {
      reason: `human revision resume failed: ${errorMessage(error)}`,
      source: "human_review_resume"
    });
    throw error;
  }
}

export function requireCurrentReviewRequest(
  db: RunnerDatabase,
  issueID: number,
  input: Record<string, unknown>
): HumanReviewRequest {
  const projection = readIssueDecisionProjection(db, issueID);
  const request = projection.request;
  if (projection.owner !== "human" || !request || request.status !== "open") {
    throw new HumanReviewConflictError("当前没有等待人类处理的验收请求；PI 仍负责自主验证或修复");
  }
  const requestID = requiredText(input.review_request_id, "review_request_id");
  const revision = positiveInteger(input.review_revision, "review_revision");
  if (requestID !== request.id || revision !== request.revision) {
    throw new HumanReviewConflictError("验收请求已更新，请刷新后重新审批");
  }
  return request;
}
