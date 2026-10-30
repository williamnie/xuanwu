import type { RunnerDatabase } from "../../db/database.ts";
import { listPiActionEvents } from "../../db/repositories/pi/actions.ts";
import { type PiIssueCompletionWatch } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { listIssueCompletionAutomationNotifications as listPiIssueCompletionWatchNotifications, listIssueCompletionAutomations as listPiIssueCompletionWatches } from "../issues/issueCompletionAutomation.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import { cleanString, unique } from "../../util/values.ts";
import { SupervisorCommitmentListInput, SupervisorCommitment, isSupervisorCommitmentWatch, SUPERVISOR_COMMITMENT_RETENTION, SUPERVISOR_COMMITMENT_SCHEMA_VERSION, CommitmentMetadata } from "./supervisorCommitmentModel.ts";
import { sweepExpiredSupervisorCommitments } from "./supervisorCommitments.ts";
import { completionNotificationState, commitmentStatus, commitmentActionID } from "./supervisorCommitmentEvents.ts";
import { boundedLimit, objectValue, optionalTimestamp } from "./supervisorCommitmentValues.ts";

export function listSupervisorCommitments(
  db: RunnerDatabase,
  input: SupervisorCommitmentListInput = {}
): SupervisorCommitment[] {
  const projectID = cleanString(input.projectID);
  const conversationID = cleanString(input.conversationID);
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

export function canonicalCommitmentCondition(value: unknown): Record<string, unknown> {
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

export function commitmentMetadata(value: unknown): CommitmentMetadata | null {
  const raw = objectValue(objectValue(value).commitment);
  if (raw.schema_version !== SUPERVISOR_COMMITMENT_SCHEMA_VERSION) return null;
  const dueAt = optionalTimestamp(raw.due_at, "commitment.due_at");
  return {
    due_at: dueAt,
    retention: SUPERVISOR_COMMITMENT_RETENTION,
    schema_version: SUPERVISOR_COMMITMENT_SCHEMA_VERSION
  };
}

export function linkedConversationIDs(db: RunnerDatabase, watch: PiIssueCompletionWatch): string[] {
  const events = listPiActionEvents(db, { actionId: commitmentActionID(watch.id) });
  return unique([watch.origin_conversation_id, ...events.map((event) => event.conversation_id)].filter(Boolean));
}
