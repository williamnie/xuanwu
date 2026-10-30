import type { RunnerDatabase } from "../../db/database.ts";
import { enqueueIssue } from "../../db/repositories/issueActions.ts";
import { createPendingPiAction, executeSafePiAction } from "../actions/actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { cancelIssueCompletionWatchAction, createIssueCompletionWatchAction, listIssueCompletionWatchesAction, watchProjectID, watchProjectIDForCancel, type IssueCompletionWatchCancelInput, type IssueCompletionWatchCreateInput, type IssueCompletionWatchListInput } from "./issueCompletionWatchActions.ts";
import { runManualContextIntake as executeManualContextIntake, type ManualContextIntakeInput } from "../intake/manualTrigger.ts";
import { cleanString } from "../../util/values.ts";
import { PiRunnerActionContext, ProposalInput } from "./runnerActionInputs.ts";
import { cleanObjectPayload } from "./runnerActionValues.ts";

export function issueStatusRuntime(context: PiRunnerActionContext) {
  return {
    bus: context.bus,
    onExecutionRequested: context.onIssueEnqueued,
    providers: context.providers
  };
}

export function manualContextIntake(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: ManualContextIntakeInput
) {
  return executeManualContextIntake(db, {
    ...input,
    conversation_id: cleanString(input.conversation_id) || cleanString(context.conversationID),
    project_id: cleanString(input.project_id) || (context.project?.id ?? ""),
    source_turn_id: cleanString(input.source_turn_id) || cleanString(context.sourceTurn?.id),
    source_turn_source: cleanString(input.source_turn_source) || cleanString(context.sourceTurn?.source) || cleanString(context.source),
    user_prompt: cleanString(input.user_prompt) || cleanString(context.sourceTurn?.userPrompt)
  }, {
    auditContext: {
      conversationID: context.conversationID,
      delegationID: context.delegationID,
      heartbeatID: context.heartbeatID,
      issueID: context.issueID,
      projectID: context.project?.id,
      source: context.source
    },
    connectorManifestDirs: context.cliConnectorDirs,
    env: context.env
  });
}

export function createCompletionWatch(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchCreateInput
) {
  const trustedTarget = context.notificationTarget;
  const enrichedInput = {
    ...input,
    origin_conversation_id: cleanString(input.origin_conversation_id) || cleanString(context.conversationID),
    source_event_id: cleanString(input.source_event_id) || cleanString(context.sourceTurn?.id),
    target_channel: canonicalNotificationConnector(
      trustedTarget?.connectorID || input.target_channel || context.source
    ),
    target_chat_id: cleanString(trustedTarget?.conversationID) || cleanString(input.target_chat_id),
    target_message_id: cleanString(trustedTarget?.replyToMessageID) || cleanString(input.target_message_id),
    target_thread_id: cleanString(trustedTarget?.threadID) || cleanString(input.target_thread_id)
  };
  const projectID = watchProjectID(db, enrichedInput);
  const actionContext = scopedRunnerChatActionContext(context, "issue_completion_watch.create", {
    issueIDs: enrichedInput.issue_ids,
    projectID
  });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue_completion_watch.create",
    payload: cleanObjectPayload({ ...enrichedInput, project_id: projectID }),
    projectID,
    rationale: enrichedInput.note
  }, () => createIssueCompletionWatchAction(db, { ...enrichedInput, project_id: projectID }));
}

export function canonicalNotificationConnector(value: unknown): string {
  const connector = cleanString(value).toLowerCase();
  if (connector === "feishu_runner_chat") return "feishu";
  if (connector === "telegram_runner_chat") return "telegram";
  if (connector.endsWith("_runner_chat")) return connector.slice(0, -"_runner_chat".length);
  return connector;
}

export function safeListCompletionWatches(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchListInput
) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  return executeSafePiAction(db, context, {
    actionType: "issue_completion_watch.list",
    payload: cleanObjectPayload({ ...input, project_id: projectID }),
    projectID,
    execute: () => listIssueCompletionWatchesAction(db, { ...input, project_id: projectID })
  });
}

export function cancelCompletionWatch(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: IssueCompletionWatchCancelInput
) {
  const projectID = watchProjectIDForCancel(db, input.watch_id);
  const actionContext = scopedRunnerChatActionContext(context, "issue_completion_watch.cancel", { projectID });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue_completion_watch.cancel",
    payload: cleanObjectPayload({ reason: input.reason, watch_id: input.watch_id }),
    projectID,
    rationale: input.reason
  }, () => cancelIssueCompletionWatchAction(db, input));
}

export function actionContextForProposal(
  context: PiRunnerActionContext,
  proposal: ProposalInput
): PiRunnerActionContext {
  return scopedRunnerChatActionContext(context, proposal.actionType, {
    issueID: proposal.issueID,
    projectID: proposal.projectID ?? ""
  });
}

export function enqueueIssueAndNotify(db: RunnerDatabase, context: PiRunnerActionContext, issueID: number) {
  const issue = enqueueIssue(db, issueID);
  context.onIssueEnqueued?.(issue.project_id);
  return issue;
}
