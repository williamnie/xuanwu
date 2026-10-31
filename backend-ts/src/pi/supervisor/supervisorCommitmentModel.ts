import { type PiIssueCompletionWatch } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { commitmentMetadata } from "./supervisorCommitmentProjection.ts";
import { objectValue } from "./supervisorCommitmentValues.ts";

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

export type CommitmentMetadata = {
  due_at: string;
  retention: typeof SUPERVISOR_COMMITMENT_RETENTION;
  schema_version: typeof SUPERVISOR_COMMITMENT_SCHEMA_VERSION;
};

export const ACTION_PREFIX = "supervisor-commitment:";

export const CANCEL_REASON = "supervisor_commitment_cancelled";

export const EXPIRE_REASON = "supervisor_commitment_expired";

export const FORGET_REASON = "supervisor_commitment_forgotten";

export const DEFAULT_LIMIT = 12;

export const MAX_LIMIT = 40;

export function containsSupervisorCommitmentMetadata(condition: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(objectValue(condition), "commitment");
}

export function isSupervisorCommitmentWatch(watch: PiIssueCompletionWatch): boolean {
  return commitmentMetadata(watch.condition) !== null;
}
