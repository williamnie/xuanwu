import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent, listPiActionEvents } from "../../db/repositories/pi/actions.ts";
import { type PiIssueCompletionWatch } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { getIssueCompletionAutomation as getPiIssueCompletionWatch } from "../issues/issueCompletionAutomation.ts";
import { createNotification } from "../../db/repositories/notifications.ts";
import { cleanString } from "../../util/values.ts";
import { SUPERVISOR_COMMITMENT_RETENTION, SupervisorCommitment, SupervisorCommitmentStatus, FORGET_REASON, EXPIRE_REASON, SupervisorCommitmentMutationResult, isSupervisorCommitmentWatch, ACTION_PREFIX } from "./supervisorCommitmentModel.ts";
import { commitmentMetadata, projectSupervisorCommitment } from "./supervisorCommitmentProjection.ts";

export function recordCommitmentEventOnce(
  db: RunnerDatabase,
  watch: PiIssueCompletionWatch,
  input: {
    actor: string;
    conversationID: string;
    decision: string;
    eventType: string;
    reason: string;
  }
): boolean {
  const actionID = commitmentActionID(watch.id);
  const duplicate = listPiActionEvents(db, { actionId: actionID, eventType: input.eventType })
    .some((event) => event.conversation_id === input.conversationID && event.decision === input.decision);
  if (duplicate) return false;
  createPiActionEvent(db, {
    action_id: actionID,
    actor: input.actor,
    conversation_id: input.conversationID,
    decision: input.decision,
    event_type: input.eventType,
    payload_json: JSON.stringify({
      due_at: commitmentMetadata(watch.condition)?.due_at ?? "",
      retention: SUPERVISOR_COMMITMENT_RETENTION,
      watch_id: watch.id,
      work_ids: watch.items.map((item) => `xw:work:issues:${item.issue_id}`)
    }),
    project_id: watch.project_id,
    reason: input.reason
  });
  return true;
}

export function createCommitmentCompletionNotification(
  db: RunnerDatabase,
  commitment: SupervisorCommitment
): void {
  const issueID = Number(commitment.goal.work_ids[0]?.split(":").at(-1) ?? 0);
  createNotification(db, {
    event: `supervisor.commitment.${commitment.status}`,
    issueID: Number.isSafeInteger(issueID) ? issueID : 0,
    message: `Commitment ${commitment.id} reached ${commitment.status}.`,
    payload: JSON.stringify({
      commitment_id: commitment.id,
      conversation_id: commitment.conversation.origin_id,
      status: commitment.status,
      watch_id: commitment.watch_id,
      work_ids: commitment.goal.work_ids
    }),
    projectID: commitment.project_id,
    title: `Supervisor commitment ${commitment.status}`
  }, new Date(), 0);
}

export function commitmentStatus(
  watch: PiIssueCompletionWatch,
  workStatuses: string[],
  dueAt: string
): SupervisorCommitmentStatus {
  if (watch.error === FORGET_REASON) return "forgotten";
  if (watch.error === EXPIRE_REASON || (watch.status === "active" && dueAt !== "" && Date.parse(dueAt) <= Date.now())) {
    return "expired";
  }
  if (watch.status === "cancelled") return "cancelled";
  if (watch.status === "failed") return "failed";
  if (watch.status === "active") return "active";
  if (workStatuses.some((status) => status === "failed")) return "failed";
  if (workStatuses.some((status) => status === "cancelled")) return "cancelled";
  return workStatuses.length > 0 && workStatuses.every((status) => status === "done") ? "completed" : "active";
}

export function completionNotificationState(
  notifications: Array<{ error: string; state: string }>
): SupervisorCommitment["completion_notification"]["state"] {
  if (notifications.length === 0) return "not_ready";
  if (notifications.some((item) => item.error !== "" || item.state === "failed")) return "failed";
  if (notifications.some((item) => item.state === "sent")) return "sent";
  return "pending";
}

export function mutationResult(db: RunnerDatabase, watchID: string): SupervisorCommitmentMutationResult {
  const watch = requireCommitmentWatch(db, watchID);
  return { commitment: projectSupervisorCommitment(db, watch), watch };
}

export function requireCommitmentWatch(db: RunnerDatabase, watchID: string): PiIssueCompletionWatch {
  const watch = getPiIssueCompletionWatch(db, cleanString(watchID));
  if (!watch) throw new Error(`PI issue completion watch ${cleanString(watchID)} not found`);
  if (!isSupervisorCommitmentWatch(watch)) throw new Error(`completion watch ${watch.id} is not a Supervisor commitment`);
  return watch;
}

export function commitmentActionID(watchID: string): string {
  return `${ACTION_PREFIX}${watchID}`;
}
