import { deleteIssues } from "../../db/repositories/issueActions.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createIssueComment } from "../../db/repositories/issueEvents.ts";
import { approveImReplyDraft, createImReplyDraft } from "../../db/repositories/imReplyOutbox.ts";
import { applyIssueStateRepair } from "../../pi/issues/issueStateManager.ts";
import { createIssueEnqueueCron } from "../../pi/runnerTools/runnerIssueScheduleActions.ts";
import { askUserActionResult, createMemoryFromAction, createReminderFromAction, createWatchThreadFromAction, noActionResult } from "../../pi/actions/nonIssueProposalActions.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { dispatchSupervisorPiAction } from "./piSupervisorActionDispatch.ts";
import { dispatchNeedsUserEscalation } from "../../notifications/piNeedsUserAction.ts";
import { cancelIssueCompletionWatchAction, createIssueCompletionWatchAction, type IssueCompletionWatchCancelInput, type IssueCompletionWatchCreateInput } from "../../pi/runnerTools/issueCompletionWatchActions.ts";
import { callMcpTool } from "../../pi/mcp/mcpToolCall.ts";
import { invokeReadOnlyAssistantTool } from "../../pi/tools/readOnlyToolInvocation.ts";
import { materializeIssueBatch } from "../../pi/runnerTools/issueBatchProposal.ts";
import { updateRunnerSettings } from "../settings/runnerSettingsApi.ts";
import { scheduleSystemRestart } from "../system/systemRestartApi.ts";
import { reviewHumanIssue } from "../../domain/review/humanReview.ts";
import { writePiNotificationPreference } from "../../pi/notifications/notificationPreferenceService.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import type { PiActionDispatchContext } from "./piActionDispatch.model.ts";
import { parsePayload, issueCreatePayload, enqueueIssueAndStartAutoRun, positivePayloadID, updateIssueStatusesAndStartAutoRun, positiveIDList, issueStatusUpdateInput, lookupIssueStatus, replyDraftPayload, actionPayload, requiredPayloadText, positiveInputID } from "./piActionDispatch.replyDraftPayload.ts";
import { requestIssueAcceptanceAction, updateExecutorIssue, createWorkflowIssue } from "./piActionDispatch.requestIssueAcceptanceAction.ts";
import { steerSession, dispatchRunControlAction, dispatchWorkControlAction, stringArray, toolPermission } from "./piActionDispatch.dispatchWorkControlAction.ts";

export async function dispatchPiAction(
  context: PiActionDispatchContext,
  action: PiAction
): Promise<unknown> {
  const payload = parsePayload(action);
  switch (action.action_type) {
    case "issue.create":
      return Array.isArray(payload.batch_items)
        ? materializeIssueBatch(context.database, payload)
        : createIssue(context.database, issueCreatePayload(payload));
    case "issue.enqueue":
      return enqueueIssueAndStartAutoRun(context, action, positivePayloadID(payload, "issue_id"));
    case "issue.cancel":
      return await updateIssueStatusesAndStartAutoRun(context, action, {
        issue_ids: positiveIDList(payload.issue_ids),
        reason: cleanString(payload.reason) || cleanString(action.rationale) || "用户明确取消 Issue",
        status: "cancelled"
      });
    case "issue.delete":
      return deleteIssues(context.database, positiveIDList(payload.issue_ids));
    case "issue.status_update":
      return await updateIssueStatusesAndStartAutoRun(context, action, issueStatusUpdateInput(payload));
    case "notification.preference.update":
      return writePiNotificationPreference(context.database, {
        ...payload,
        conversation_id: cleanString(payload.conversation_id) || action.conversation_id,
        policy_kind: "user_preference",
        project_id: cleanString(payload.project_id) || action.project_id,
        run_group_id: cleanString(payload.run_group_id)
      });
    case "human_review.respond":
      return await reviewHumanIssue(
        context.database,
        positivePayloadID(payload, "issue_id"),
        payload,
        { bus: context.bus, providers: context.providers }
      );
    case "issue.status_lookup":
      return lookupIssueStatus(context.database, payload);
    case "runner.settings_update":
      return await updateRunnerSettings(context, payload);
    case "system.restart": {
      const result = scheduleSystemRestart({
        audit: context.auditSystemRestart,
        providers: context.providers,
        restartDelayMs: context.restartDelayMs,
        restartProcess: context.restartProcess,
        supervisorManaged: context.supervisorManaged
      });
      if (!result) throw new Error("当前服务不是 launchd/systemd 托管，无法安全重启");
      return result;
    }
    case "message.reply_draft":
      return createImReplyDraft(context.database, replyDraftPayload(payload, action));
    case "message.reply_send":
      return approveImReplyDraft(context.database, createImReplyDraft(
        context.database,
        replyDraftPayload(payload, action)
      ).id);
    case "issue.schedule_enqueue":
      return createIssueEnqueueCron(context.database, payload);
    case "ask_user":
      return askUserActionResult(action, payload);
    case "watch_thread":
      return createWatchThreadFromAction(context.database, action, payload);
    case "reminder.create":
      return createReminderFromAction(context.database, action, payload);
    case "memory.create":
      return createMemoryFromAction(context.database, action, payload);
    case "no_action":
      return noActionResult(action, payload);
    case "issue_completion_watch.create":
      return createIssueCompletionWatchAction(context.database, payload as IssueCompletionWatchCreateInput);
    case "issue_completion_watch.cancel":
      return cancelIssueCompletionWatchAction(context.database, payload as IssueCompletionWatchCancelInput);
    case "issue.comment":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), payload);
    case "issue.state_repair":
      return applyIssueStateRepair(context.database, actionPayload(action, payload));
    case "issue.acceptance_request":
      return await requestIssueAcceptanceAction(context, action, payload);
    case "agent.executor_assign":
      return await updateExecutorIssue(context.database, action, payload);
    case "agent.workflow_request":
      return createWorkflowIssue(context, action, payload);
    case "needs_user.escalate":
      return dispatchNeedsUserEscalation(context, action, payload);
    case "issue.retry":
    case "issue.retry_after":
    case "issue.supervisor_decision":
    case "session.resume_followup":
      return await dispatchSupervisorPiAction(context, action, payload);
    case "session.steer":
      return await steerSession(context, payload);
    case "run.interrupt":
    case "run.resume":
    case "run.retry":
      return await dispatchRunControlAction(context, action, payload);
    case "work.create":
    case "work.update":
    case "work.enqueue":
    case "work.retry":
    case "work.cancel":
      return await dispatchWorkControlAction(context, action, payload);
    case "mcp.tool.call":
      return callMcpTool({
        auditContext: {
          conversationID: action.conversation_id,
          delegationID: action.delegation_id,
          heartbeatID: action.heartbeat_id,
          issueID: action.issue_id || undefined,
          projectID: action.project_id,
          source: action.source || "pi_action_dispatch"
        },
        capabilityID: requiredPayloadText(payload, "capability_id"),
        db: context.database,
        input: objectValue(payload.input),
        registry: { database: context.database },
        timeoutMs: positiveInputID(payload.timeout_ms) || undefined
      });
    case "assistant.tool.call":
      return await invokeReadOnlyAssistantTool({
        auditContext: {
          conversationID: action.conversation_id,
          delegationID: action.delegation_id,
          heartbeatID: action.heartbeat_id,
          issueID: action.issue_id || undefined,
          projectID: action.project_id,
          source: action.source || "pi_action_dispatch"
        },
        db: context.database,
        input: objectValue(payload.input),
        manifestDirs: stringArray(payload.manifest_dirs),
        maxPermission: toolPermission(payload.permission),
        projectID: action.project_id,
        providerID: requiredPayloadText(payload, "provider_id"),
        toolName: requiredPayloadText(payload, "tool_name")
      });
    default:
      throw new Error(`unsupported PI action type: ${action.action_type}`);
  }
}
