import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";

export const PI_ACCEPTANCE_ACTIVITY_EVENT_TYPES = {
  queued: "issue.pi_acceptance_queued.v1",
  running: "issue.pi_acceptance_started.v1",
  waiting: "issue.pi_acceptance_waiting.v1",
  completed: "issue.pi_acceptance_completed.v1",
  failed: "issue.pi_acceptance_failed.v1"
} as const;

export type PiAcceptanceActivityStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type PiAcceptanceActivity = {
  attempt: number;
  card_fingerprint: string;
  decision: string;
  error: string;
  event_id: number;
  project_id: string;
  source: string;
  status: PiAcceptanceActivityStatus;
  updated_at: string;
};

const EVENT_STATUS = new Map<string, PiAcceptanceActivityStatus>(
  Object.entries(PI_ACCEPTANCE_ACTIVITY_EVENT_TYPES).map(([status, eventType]) => [
    eventType,
    status as PiAcceptanceActivityStatus
  ])
);

export function readPiAcceptanceActivity(
  db: RunnerDatabase,
  issueID: number
): PiAcceptanceActivity | null {
  const event = listIssueEvents(db, issueID, {
    limit: 1,
    types: Object.values(PI_ACCEPTANCE_ACTIVITY_EVENT_TYPES)
  })[0];
  const status = event ? EVENT_STATUS.get(event.type) : undefined;
  if (!event || !status) return null;
  const payload = objectPayload(event.payload);
  return {
    attempt: positiveInteger(payload.attempt),
    card_fingerprint: cleanString(payload.card_fingerprint),
    decision: cleanString(payload.decision),
    error: cleanString(payload.error),
    event_id: event.id,
    project_id: cleanString(payload.project_id),
    source: cleanString(payload.source),
    status,
    updated_at: event.created_at
  };
}

export function recordPiAcceptanceActivity(
  db: RunnerDatabase,
  issueID: number,
  status: PiAcceptanceActivityStatus,
  input: {
    attempt: number;
    card_fingerprint?: string;
    decision?: string;
    error?: string;
    project_id: string;
    source: string;
  }
): PiAcceptanceActivity {
  recordIssueEvent(db, issueID, PI_ACCEPTANCE_ACTIVITY_EVENT_TYPES[status], {
    attempt: input.attempt,
    card_fingerprint: cleanString(input.card_fingerprint),
    decision: cleanString(input.decision),
    error: cleanString(input.error),
    project_id: input.project_id,
    source: input.source,
    status
  });
  const activity = readPiAcceptanceActivity(db, issueID);
  if (!activity) throw new Error("PI acceptance activity was not persisted");
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
