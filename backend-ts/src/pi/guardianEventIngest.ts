import type { RunnerDatabase } from "../db/database.ts";
import type { Issue } from "../db/repositories/issues.ts";
import { createPiGuardianEvent, type PiGuardianEvent } from "../db/repositories/pi/guardianEvents.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type IssueLifecycleEventInput = {
  conversationID?: string;
  eventType?: string;
  issue: Issue;
  runGroupID?: string;
};
export type PiGuardianEventIngestInput = {
  conversationID?: string; createdAt?: string; error?: string; eventType: string;
  id?: string; idempotencyKey?: string; issueID?: number; normalizedPayload?: unknown;
  projectID?: string; redactionProfile?: string; runGroupID?: string;
  severity?: string; source: string; sourceEventID?: string; sourceSequence?: number;
  status?: string;
};

type IssueEventAnchor = { id: number; type: string };

export function ingestIssueLifecycleEvent(
  db: RunnerDatabase,
  input: IssueLifecycleEventInput
): PiGuardianEvent {
  const anchor = latestIssueLifecycleAnchor(db, input.issue.id);
  const eventType = cleanString(input.eventType) || anchor?.type || "issue.status_changed";
  const sourceEventID = anchor ? `issue_event:${anchor.id}` : fallbackSourceEventID(input.issue, eventType);
  const runGroupID = cleanString(input.runGroupID) || latestRunGroupIDForIssue(db, input.issue.id);
  return ingestPiGuardianEvent(db, {
    conversationID: cleanString(input.conversationID),
    eventType,
    idempotencyKey: lifecycleEventKey(input.issue, eventType, sourceEventID),
    issueID: input.issue.id,
    normalizedPayload: lifecyclePayload(input.issue),
    projectID: input.issue.project_id,
    runGroupID,
    severity: lifecycleSeverity(input.issue.status),
    source: anchor ? "issue_events" : "event_bus",
    sourceEventID,
    sourceSequence: anchor?.id ?? 0,
    status: "consumed"
  });
}

export function ingestPiGuardianEvent(
  db: RunnerDatabase,
  input: PiGuardianEventIngestInput
): PiGuardianEvent {
  return createPiGuardianEvent(db, {
    conversation_id: cleanString(input.conversationID),
    created_at: cleanString(input.createdAt),
    error: cleanString(input.error),
    event_type: input.eventType,
    id: cleanString(input.id),
    idempotency_key: cleanString(input.idempotencyKey),
    issue_id: integer(input.issueID),
    normalized_payload_json: redactedPayload(input.normalizedPayload ?? {}),
    project_id: cleanString(input.projectID),
    redaction_profile: cleanString(input.redactionProfile) || "prompt",
    run_group_id: cleanString(input.runGroupID),
    severity: cleanString(input.severity) || "info",
    source: cleanString(input.source),
    source_event_id: cleanString(input.sourceEventID),
    source_sequence: integer(input.sourceSequence),
    status: cleanString(input.status) || "pending"
  });
}

function latestIssueLifecycleAnchor(db: RunnerDatabase, issueID: number): IssueEventAnchor | null {
  return db.sqlite.query<IssueEventAnchor, [number]>(
    `select id, type from issue_events
     where issue_id=? and type in ('issue.status_changed', 'issue.created')
     order by id desc limit 1`
  ).get(issueID) ?? null;
}

function latestRunGroupIDForIssue(db: RunnerDatabase, issueID: number): string {
  const row = db.sqlite.query<{ run_group_id: string }, [number]>(
    `select run_group_id from pi_run_group_items
     where issue_id=? order by joined_at desc, run_group_id desc limit 1`
  ).get(issueID);
  return cleanString(row?.run_group_id);
}

function lifecycleEventKey(issue: Issue, eventType: string, sourceEventID: string): string {
  return `${eventType}:${issue.project_id}:${issue.id}:${sourceEventID}`;
}

function fallbackSourceEventID(issue: Issue, eventType: string): string {
  return `${eventType}:${issue.id}:${issue.status}`;
}

function lifecyclePayload(issue: Issue): Record<string, string | number> {
  return {
    error: redactSensitiveText(issue.error),
    issue_id: issue.id,
    project_id: issue.project_id,
    status: issue.status,
    title: issue.title
  };
}

function lifecycleSeverity(status: string): string {
  if (status === "failed") return "needs_user";
  if (status === "needs_user") return "needs_user";
  return "info";
}

function redactedPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactedPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, redactedPayload(item)]));
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
