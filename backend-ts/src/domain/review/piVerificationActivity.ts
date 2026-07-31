import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";

export const PI_VERIFICATION_EVENT_TYPES = {
  queued: "issue.pi_verification_queued.v1",
  running: "issue.pi_verification_started.v1",
  waiting: "issue.pi_verification_waiting.v1",
  completed: "issue.pi_verification_completed.v1",
  failed: "issue.pi_verification_failed.v1"
} as const;

export type PiVerificationActivityStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type PiVerificationActivity = {
  attempt: number;
  error: string;
  event_id: number;
  project_id: string;
  source: string;
  status: PiVerificationActivityStatus;
  updated_at: string;
};

const EVENT_STATUS = new Map<string, PiVerificationActivityStatus>(
  Object.entries(PI_VERIFICATION_EVENT_TYPES).map(([status, eventType]) => [
    eventType,
    status as PiVerificationActivityStatus
  ])
);

export function readPiVerificationActivity(
  db: RunnerDatabase,
  issueID: number
): PiVerificationActivity | null {
  const event = listIssueEvents(db, issueID, {
    limit: 1,
    types: Object.values(PI_VERIFICATION_EVENT_TYPES)
  })[0];
  const status = event ? EVENT_STATUS.get(event.type) : undefined;
  if (!event || !status) return null;
  const payload = objectPayload(event.payload);
  return {
    attempt: positiveInteger(payload.attempt),
    error: cleanString(payload.error),
    event_id: event.id,
    project_id: cleanString(payload.project_id),
    source: cleanString(payload.source),
    status,
    updated_at: event.created_at
  };
}

export function recordPiVerificationActivity(
  db: RunnerDatabase,
  issueID: number,
  status: PiVerificationActivityStatus,
  input: {
    attempt: number;
    error?: string;
    project_id: string;
    source: string;
  }
): PiVerificationActivity {
  recordIssueEvent(db, issueID, PI_VERIFICATION_EVENT_TYPES[status], {
    attempt: input.attempt,
    error: cleanString(input.error),
    project_id: input.project_id,
    source: input.source,
    status
  });
  const activity = readPiVerificationActivity(db, issueID);
  if (!activity) throw new Error("PI verification activity was not persisted");
  return activity;
}

function objectPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
