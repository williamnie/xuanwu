import type { RunnerDatabase } from "../db/database.ts";
import { getPiConversation } from "../db/repositories/pi/conversations.ts";
import { createPiActionEvent, listPiActionEvents } from "../db/repositories/pi/actions.ts";
import {
  type PiIssueCompletionWatch,
  type PiIssueCompletionWatchInput
} from "../db/repositories/pi/issueCompletionWatches.ts";
import {
  cancelIssueCompletionAutomation as cancelPiIssueCompletionWatch,
  createIssueCompletionAutomation as createPiIssueCompletionWatch,
  getIssueCompletionAutomation as getPiIssueCompletionWatch,
  listIssueCompletionAutomationNotifications as listPiIssueCompletionWatchNotifications,
  listIssueCompletionAutomations as listPiIssueCompletionWatches
} from "./issueCompletionAutomation.ts";
import { createNotification } from "../db/repositories/notifications.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";

export const SUPERVISOR_COMMITMENT_SCHEMA_VERSION = "xw.supervisor-commitment.v1" as const;
export const SUPERVISOR_COMMITMENT_RETENTION = "operational_not_memory" as const;

export type SupervisorCommitmentStatus =
  | "active"
  | "cancelled"
  | "completed"
  | "expired"
  | "failed"
  | "forgotten";

export type SupervisorGoal = {
  id: string;
  statements: string[];
  work_ids: string[];
};

export type SupervisorCommitment = {
  completion_notification: {
    intent_ids: string[];
    state: "not_ready" | "pending" | "sent" | "failed";
  };
  conversation: {
    linked_ids: string[];
    origin_id: string;
  };
  created_at: string;
  due_at: string;
  goal: SupervisorGoal;
  id: string;
  project_id: string;
  retention: typeof SUPERVISOR_COMMITMENT_RETENTION;
  source_of_truth: {
    audit: "pi_action_events";
    lifecycle: "automation_watches";
    work: "issues-via-work-adapter";
  };
  status: SupervisorCommitmentStatus;
  updated_at: string;
  watch_id: string;
  work_statuses: Array<{ status: string; work_id: string }>;
};

export type SupervisorCommitmentMutationResult = {
  commitment: SupervisorCommitment;
  watch: PiIssueCompletionWatch;
};

export type SupervisorCommitmentListInput = {
  conversationID?: string;
  limit?: number;
  projectID?: string;
  statuses?: SupervisorCommitmentStatus[];
};

type CommitmentMetadata = {
  due_at: string;
  retention: typeof SUPERVISOR_COMMITMENT_RETENTION;
  schema_version: typeof SUPERVISOR_COMMITMENT_SCHEMA_VERSION;
};

const ACTION_PREFIX = "supervisor-commitment:";
const CANCEL_REASON = "supervisor_commitment_cancelled";
const EXPIRE_REASON = "supervisor_commitment_expired";
const FORGET_REASON = "supervisor_commitment_forgotten";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 40;

export function containsSupervisorCommitmentMetadata(condition: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(objectValue(condition), "commitment");
}

export function isSupervisorCommitmentWatch(watch: PiIssueCompletionWatch): boolean {
  return commitmentMetadata(watch.condition) !== null;
}

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
    actor: cleanText(input.requested_by) || "supervisor",
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
      actor: cleanText(input.actor) || "user",
      conversationID: cleanText(input.conversationID) || watch.origin_conversation_id,
      decision: forgotten ? "forgotten" : "cancelled",
      eventType,
      reason: cleanText(input.reason) || marker
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
    actor: cleanText(input.actor) || "user",
    conversationID,
    decision: "active",
    eventType: "supervisor_commitment_resumed",
    reason: cleanText(input.reason) || "Continue unfinished Work in this conversation"
  });
  return projectSupervisorCommitment(db, watch);
}

export function linkSupervisorCommitmentsForConversation(
  db: RunnerDatabase,
  input: { conversationID: string; projectID?: string; workIDs: string[] }
): SupervisorCommitment[] {
  const conversationID = requiredText(input.conversationID, "conversationID");
  const targetWorkIDs = new Set(input.workIDs.map(cleanText).filter(Boolean));
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
  const watch = getPiIssueCompletionWatch(db, cleanText(watchID));
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
  const watch = getPiIssueCompletionWatch(db, cleanText(watchID));
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

export function listSupervisorCommitments(
  db: RunnerDatabase,
  input: SupervisorCommitmentListInput = {}
): SupervisorCommitment[] {
  const projectID = cleanText(input.projectID);
  const conversationID = cleanText(input.conversationID);
  const statuses = new Set(input.statuses ?? []);
  const limit = boundedLimit(input.limit);
  return listPiIssueCompletionWatches(db, { limit: 100, projectId: projectID })
    .filter(isSupervisorCommitmentWatch)
    .map((watch) => projectSupervisorCommitment(db, watch))
    .filter((commitment) => projectID !== "" || conversationID === "" ||
      commitment.conversation.linked_ids.includes(conversationID))
    .filter((commitment) => statuses.size === 0 || statuses.has(commitment.status))
    .slice(0, limit);
}

export function projectSupervisorCommitment(
  db: RunnerDatabase,
  watch: PiIssueCompletionWatch
): SupervisorCommitment {
  const metadata = commitmentMetadata(watch.condition);
  if (!metadata) throw new Error(`completion watch ${watch.id} is not a Supervisor commitment`);
  const works = watch.items.map((item) => getIssueAsWork(db, item.issue_id)).filter(Boolean);
  if (works.length === 0 || works.length !== watch.items.length) {
    throw new Error(`Supervisor commitment ${watch.id} references missing authoritative Work`);
  }
  const workStatuses = works.map((work) => ({ status: work!.status, work_id: work!.id }));
  const workIDs = works.map((work) => work!.id);
  const notifications = listPiIssueCompletionWatchNotifications(db, watch.id);
  return {
    completion_notification: {
      intent_ids: notifications.map((item) => item.intent.id),
      state: completionNotificationState(notifications.map((item) => ({
        error: item.intent.error || item.outbox?.last_error || "",
        state: item.outbox?.status || item.intent.state
      })))
    },
    conversation: {
      linked_ids: linkedConversationIDs(db, watch),
      origin_id: watch.origin_conversation_id
    },
    created_at: watch.created_at,
    due_at: metadata.due_at,
    goal: {
      id: `supervisor-goal:${watch.id}`,
      statements: works.map((work) => work!.goal),
      work_ids: workIDs
    },
    id: `supervisor-commitment:${watch.id}`,
    project_id: watch.project_id,
    retention: SUPERVISOR_COMMITMENT_RETENTION,
    source_of_truth: {
      audit: "pi_action_events",
      lifecycle: "automation_watches",
      work: "issues-via-work-adapter"
    },
    status: commitmentStatus(watch, workStatuses.map((item) => item.status), metadata.due_at),
    updated_at: watch.updated_at,
    watch_id: watch.id,
    work_statuses: workStatuses
  };
}

export function buildSupervisorCommitmentPromptContext(
  db: RunnerDatabase,
  input: { conversationID?: string; projectID?: string; now?: Date } = {}
): string {
  sweepExpiredSupervisorCommitments(db, input.now);
  const commitments = listSupervisorCommitments(db, {
    conversationID: input.conversationID,
    limit: 8,
    projectID: input.projectID,
    statuses: ["active"]
  });
  const projection = commitments.map((commitment) => ({
    commitment_id: commitment.id,
    due_at: commitment.due_at,
    goal: commitment.goal,
    origin_conversation_id: commitment.conversation.origin_id,
    status: commitment.status,
    watch_id: commitment.watch_id,
    work_statuses: commitment.work_statuses
  }));
  return [
    "Supervisor commitment context (operational projection, not long-term memory):",
    projection.length > 0 ? JSON.stringify(projection, null, 2) : "- No active commitments for this context.",
    "Authority: Work goal/status comes from issues-via-work-adapter; lifecycle and completion notification come from native automation_watches.",
    "Never treat chat prose as a commitment. Create one only after authoritative Work exists and issue_completion_watch_create succeeds with xw.supervisor-commitment.v1 metadata.",
    "A temporary follow-up promise, due date, cancellation, or resume link must stay in this operational projection and must not be written to Supervisor long-term memory."
  ].join("\n");
}

function canonicalCommitmentCondition(value: unknown): Record<string, unknown> {
  const condition = objectValue(value);
  const raw = objectValue(condition.commitment);
  if (raw.schema_version !== SUPERVISOR_COMMITMENT_SCHEMA_VERSION) {
    throw new Error(`commitment.schema_version must be ${SUPERVISOR_COMMITMENT_SCHEMA_VERSION}`);
  }
  const dueAt = optionalTimestamp(raw.due_at, "commitment.due_at");
  return {
    ...condition,
    commitment: {
      due_at: dueAt,
      retention: SUPERVISOR_COMMITMENT_RETENTION,
      schema_version: SUPERVISOR_COMMITMENT_SCHEMA_VERSION
    },
    terminal_statuses: ["done", "failed", "cancelled"],
    type: "all_terminal"
  };
}

function commitmentMetadata(value: unknown): CommitmentMetadata | null {
  const raw = objectValue(objectValue(value).commitment);
  if (raw.schema_version !== SUPERVISOR_COMMITMENT_SCHEMA_VERSION) return null;
  const dueAt = optionalTimestamp(raw.due_at, "commitment.due_at");
  return {
    due_at: dueAt,
    retention: SUPERVISOR_COMMITMENT_RETENTION,
    schema_version: SUPERVISOR_COMMITMENT_SCHEMA_VERSION
  };
}

function linkedConversationIDs(db: RunnerDatabase, watch: PiIssueCompletionWatch): string[] {
  const events = listPiActionEvents(db, { actionId: commitmentActionID(watch.id) });
  return unique([watch.origin_conversation_id, ...events.map((event) => event.conversation_id)].filter(Boolean));
}

function recordCommitmentEventOnce(
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

function createCommitmentCompletionNotification(
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

function commitmentStatus(
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

function completionNotificationState(
  notifications: Array<{ error: string; state: string }>
): SupervisorCommitment["completion_notification"]["state"] {
  if (notifications.length === 0) return "not_ready";
  if (notifications.some((item) => item.error !== "" || item.state === "failed")) return "failed";
  if (notifications.some((item) => item.state === "sent")) return "sent";
  return "pending";
}

function mutationResult(db: RunnerDatabase, watchID: string): SupervisorCommitmentMutationResult {
  const watch = requireCommitmentWatch(db, watchID);
  return { commitment: projectSupervisorCommitment(db, watch), watch };
}

function requireCommitmentWatch(db: RunnerDatabase, watchID: string): PiIssueCompletionWatch {
  const watch = getPiIssueCompletionWatch(db, cleanText(watchID));
  if (!watch) throw new Error(`PI issue completion watch ${cleanText(watchID)} not found`);
  if (!isSupervisorCommitmentWatch(watch)) throw new Error(`completion watch ${watch.id} is not a Supervisor commitment`);
  return watch;
}

function commitmentActionID(watchID: string): string {
  return `${ACTION_PREFIX}${watchID}`;
}

function assertUnfinishedAuthoritativeWork(db: RunnerDatabase, value: unknown): void {
  const issueIDs = uniquePositiveIntegers(value);
  if (issueIDs.length === 0) throw new Error("issue_ids is required for a Supervisor commitment");
  for (const issueID of issueIDs) {
    const work = getIssueAsWork(db, issueID);
    if (!work) throw new Error(`authoritative Work xw:work:issues:${issueID} not found`);
    if (["done", "failed", "cancelled"].includes(work.status)) {
      throw new Error(`authoritative Work ${work.id} is already ${work.status}`);
    }
  }
}

function uniquePositiveIntegers(value: unknown): number[] {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.filter((item): item is number => (
    typeof item === "number" && Number.isSafeInteger(item) && item > 0
  )))];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function optionalTimestamp(value: unknown, field: string): string {
  const text = cleanText(value);
  if (text === "") return "";
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an RFC3339 timestamp`);
  return new Date(text).toISOString();
}

function requiredText(value: unknown, field: string): string {
  const text = cleanText(value);
  if (text === "") throw new Error(`${field} is required for a Supervisor commitment`);
  return text;
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
