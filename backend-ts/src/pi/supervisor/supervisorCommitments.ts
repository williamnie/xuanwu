import type { RunnerDatabase } from "../../db/database.ts";
import { getPiConversation } from "../../db/repositories/pi/conversations.ts";
import { type PiIssueCompletionWatchInput } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { cancelIssueCompletionAutomation as cancelPiIssueCompletionWatch, createIssueCompletionAutomation as createPiIssueCompletionWatch, getIssueCompletionAutomation as getPiIssueCompletionWatch, listIssueCompletionAutomations as listPiIssueCompletionWatches } from "../issues/issueCompletionAutomation.ts";
import { cleanString } from "../../util/values.ts";
import { SupervisorCommitmentMutationResult, isSupervisorCommitmentWatch, FORGET_REASON, CANCEL_REASON, SupervisorCommitment, EXPIRE_REASON } from "./supervisorCommitmentModel.ts";
import { canonicalCommitmentCondition, projectSupervisorCommitment, listSupervisorCommitments, commitmentMetadata } from "./supervisorCommitmentProjection.ts";
import { recordCommitmentEventOnce, mutationResult, requireCommitmentWatch, createCommitmentCompletionNotification } from "./supervisorCommitmentEvents.ts";
import { requiredText, assertUnfinishedAuthoritativeWork } from "./supervisorCommitmentValues.ts";

export function createSupervisorCommitment(
  db: RunnerDatabase,
  input: PiIssueCompletionWatchInput,
  currentTime = new Date()
): SupervisorCommitmentMutationResult {
  const condition = canonicalCommitmentCondition(input.condition);
  const originConversationID = requiredText(input.origin_conversation_id, "origin_conversation_id");
  if (!getPiConversation(db, originConversationID)) {
    throw new Error(`PI conversation ${originConversationID} not found`);
  }
  assertUnfinishedAuthoritativeWork(db, input.issue_ids);
  const watch = createPiIssueCompletionWatch(db, { ...input, condition });
  if (!isSupervisorCommitmentWatch(watch)) {
    throw new Error(`completion watch ${watch.id} conflicts with a non-commitment watch`);
  }
  recordCommitmentEventOnce(db, watch, {
    actor: cleanString(input.requested_by) || "supervisor",
    conversationID: originConversationID,
    decision: "active",
    eventType: "supervisor_commitment_created",
    reason: "Commitment linked to authoritative Work and the existing completion-watch lifecycle"
  });
  const expired = expireSupervisorCommitmentIfDue(db, watch.id, currentTime);
  return expired ?? mutationResult(db, watch.id);
}

export function cancelSupervisorCommitment(
  db: RunnerDatabase,
  watchID: string,
  input: { actor?: string; conversationID?: string; forget?: boolean; reason?: string } = {}
): SupervisorCommitmentMutationResult {
  const watch = requireCommitmentWatch(db, watchID);
  const forgotten = input.forget === true;
  const marker = forgotten ? FORGET_REASON : CANCEL_REASON;
  const eventType = forgotten ? "supervisor_commitment_forgotten" : "supervisor_commitment_cancelled";
  const write = db.transaction(() => {
    const cancelled = cancelPiIssueCompletionWatch(db, watch.id, marker);
    recordCommitmentEventOnce(db, cancelled, {
      actor: cleanString(input.actor) || "user",
      conversationID: cleanString(input.conversationID) || watch.origin_conversation_id,
      decision: forgotten ? "forgotten" : "cancelled",
      eventType,
      reason: cleanString(input.reason) || marker
    });
    return mutationResult(db, watch.id);
  });
  return write.immediate();
}

export function resumeSupervisorCommitment(
  db: RunnerDatabase,
  watchID: string,
  input: { actor?: string; conversationID: string; reason?: string }
): SupervisorCommitment {
  const watch = requireCommitmentWatch(db, watchID);
  const commitment = projectSupervisorCommitment(db, watch);
  if (commitment.status !== "active") {
    throw new Error(`Supervisor commitment ${commitment.id} is ${commitment.status}, not active`);
  }
  const conversationID = requiredText(input.conversationID, "conversationID");
  if (!getPiConversation(db, conversationID)) throw new Error(`PI conversation ${conversationID} not found`);
  recordCommitmentEventOnce(db, watch, {
    actor: cleanString(input.actor) || "user",
    conversationID,
    decision: "active",
    eventType: "supervisor_commitment_resumed",
    reason: cleanString(input.reason) || "Continue unfinished Work in this conversation"
  });
  return projectSupervisorCommitment(db, watch);
}

export function linkSupervisorCommitmentsForConversation(
  db: RunnerDatabase,
  input: { conversationID: string; projectID?: string; workIDs: string[] }
): SupervisorCommitment[] {
  const conversationID = requiredText(input.conversationID, "conversationID");
  const targetWorkIDs = new Set(input.workIDs.map(cleanString).filter(Boolean));
  if (targetWorkIDs.size === 0) return [];
  const linked: SupervisorCommitment[] = [];
  for (const commitment of listSupervisorCommitments(db, {
    projectID: input.projectID,
    statuses: ["active"]
  })) {
    if (!commitment.goal.work_ids.some((workID) => targetWorkIDs.has(workID))) continue;
    if (commitment.conversation.linked_ids.includes(conversationID)) {
      linked.push(commitment);
      continue;
    }
    linked.push(resumeSupervisorCommitment(db, commitment.watch_id, {
      actor: "deterministic_supervisor_context",
      conversationID,
      reason: "The user explicitly referenced unfinished Work linked to this commitment"
    }));
  }
  return linked;
}

export function expireSupervisorCommitmentIfDue(
  db: RunnerDatabase,
  watchID: string,
  currentTime = new Date()
): SupervisorCommitmentMutationResult | null {
  const watch = getPiIssueCompletionWatch(db, cleanString(watchID));
  if (!watch || watch.status !== "active" || !isSupervisorCommitmentWatch(watch)) return null;
  const dueAt = commitmentMetadata(watch.condition)?.due_at ?? "";
  if (dueAt === "" || Date.parse(dueAt) > currentTime.getTime()) return null;
  const write = db.transaction(() => {
    const expired = cancelPiIssueCompletionWatch(db, watch.id, EXPIRE_REASON);
    recordCommitmentEventOnce(db, expired, {
      actor: "supervisor_commitment_clock",
      conversationID: watch.origin_conversation_id,
      decision: "expired",
      eventType: "supervisor_commitment_expired",
      reason: `Commitment due_at ${dueAt} elapsed before authoritative Work completion`
    });
    return mutationResult(db, watch.id);
  });
  return write.immediate();
}

export function sweepExpiredSupervisorCommitments(
  db: RunnerDatabase,
  currentTime = new Date()
): { expired: number; scanned: number } {
  const watches = listPiIssueCompletionWatches(db, { limit: 100, status: "active" })
    .filter(isSupervisorCommitmentWatch);
  let expired = 0;
  for (const watch of watches) {
    if (expireSupervisorCommitmentIfDue(db, watch.id, currentTime)) expired += 1;
  }
  return { expired, scanned: watches.length };
}

export function recordSupervisorCommitmentTerminalOutcome(
  db: RunnerDatabase,
  watchID: string
): SupervisorCommitment | null {
  const watch = getPiIssueCompletionWatch(db, cleanString(watchID));
  if (!watch || !isSupervisorCommitmentWatch(watch)) return null;
  const commitment = projectSupervisorCommitment(db, watch);
  if (!["cancelled", "completed", "failed"].includes(commitment.status)) return commitment;
  const recorded = recordCommitmentEventOnce(db, watch, {
    actor: "supervisor_commitment_observer",
    conversationID: watch.origin_conversation_id,
    decision: commitment.status,
    eventType: `supervisor_commitment_${commitment.status}`,
    reason: `Authoritative Work reached commitment outcome ${commitment.status}`
  });
  if (recorded) createCommitmentCompletionNotification(db, commitment);
  return projectSupervisorCommitment(db, watch);
}

export { SUPERVISOR_COMMITMENT_RETENTION, containsSupervisorCommitmentMetadata, isSupervisorCommitmentWatch } from "./supervisorCommitmentModel.ts";
export { listSupervisorCommitments, buildSupervisorCommitmentPromptContext } from "./supervisorCommitmentProjection.ts";
