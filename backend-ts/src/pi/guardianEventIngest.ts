import type { RunnerDatabase } from "../db/database.ts";
import type { Issue } from "../db/repositories/issues.ts";
import { createPiGuardianEvent, type PiGuardianEvent } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type IssueLifecycleEventInput = {
  conversationID?: string;
  eventType?: string;
  issue: Issue;
  runGroupID?: string;
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
  return createPiGuardianEvent(db, {
    conversation_id: cleanString(input.conversationID),
    event_type: eventType,
    idempotency_key: lifecycleEventKey(input.issue, eventType, sourceEventID),
    issue_id: input.issue.id,
    normalized_payload_json: lifecyclePayload(input.issue),
    project_id: input.issue.project_id,
    run_group_id: runGroupID,
    severity: lifecycleSeverity(input.issue.status),
    source: anchor ? "issue_events" : "event_bus",
    source_event_id: sourceEventID,
    source_sequence: anchor?.id ?? 0,
    status: "consumed"
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
  if (status === "failed" || status === "pending_verification") return "watch";
  return "info";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
