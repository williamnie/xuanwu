import { type PiAction } from "../../db/repositories/pi.ts";
import type { SupervisorDispatchContext } from "./piSupervisorActionDispatch.model.ts";
import { resumeSessionFollowup, retryIssueNow, scheduleRetryAfter, recordSupervisorDecision } from "./piSupervisorActionDispatch.resumeSessionFollowup.ts";

export async function dispatchSupervisorPiAction(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (action.action_type === "session.resume_followup") return resumeSessionFollowup(context, action, payload);
  if (action.action_type === "issue.retry") return retryIssueNow(context, action, payload);
  if (action.action_type === "issue.retry_after") return scheduleRetryAfter(context, action, payload);
  if (action.action_type === "issue.supervisor_decision") return recordSupervisorDecision(context, action, payload);
  throw new Error(`unsupported supervisor PI action type: ${action.action_type}`);
}
