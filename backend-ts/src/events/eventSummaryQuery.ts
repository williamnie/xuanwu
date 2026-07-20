import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  eventProjectionStatus,
  type EventSummaryProjection,
  type EventSummaryProjectionFilter
} from "../db/repositories/eventSummaryProjection.ts";
import {
  compactProjectionStatus,
  getEventSummaryProjectionSwitch,
  listEventSummaryProjectionForRead,
  projectPendingCompactEventSummaries
} from "../db/repositories/compactEventSummaryProjection.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import {
  EVENT_SUMMARY_PROJECTOR_VERSION,
  EVENT_SUMMARY_QUERY_SCHEMA_VERSION,
  projectPendingEventSummaries
} from "./eventSummaryProjector.ts";

export type PublicEventSummary = {
  created_at: string;
  id: number;
  issue_id: number;
  payload: string;
  policy_id: string;
  project_id: string;
  projection_version: string;
  raw_method: string;
  retention_tier: string;
  run_id: string;
  source_event_id: number;
  source_payload_bytes: number;
  source_sha256: string;
  summary: string;
  summary_sha256: string;
  type: string;
};

export type EventSummaryQueryResult = {
  items: PublicEventSummary[];
  schema_version: typeof EVENT_SUMMARY_QUERY_SCHEMA_VERSION;
  source_of_truth: "issue_events";
  watermark: ReturnType<typeof eventProjectionStatus> | ReturnType<typeof compactProjectionStatus>;
};

export function queryEventSummaries(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {}
): EventSummaryQueryResult {
  if (filter.issueID !== undefined && !getIssue(db, filter.issueID)) throw new ProjectNotFoundError();
  projectPendingEventSummaries(db);
  const projectionSwitch = getEventSummaryProjectionSwitch(db);
  if (projectionSwitch.read_version === "v2" || projectionSwitch.observation_started_at) {
    projectPendingCompactEventSummaries(db);
  }
  return {
    items: listEventSummaryProjectionForRead(db, filter).map(publicSummary),
    schema_version: EVENT_SUMMARY_QUERY_SCHEMA_VERSION,
    source_of_truth: "issue_events",
    watermark: projectionSwitch.read_version === "v2"
      ? compactProjectionStatus(db)
      : eventProjectionStatus(db)
  };
}

function publicSummary(row: EventSummaryProjection): PublicEventSummary {
  return {
    id: row.source_event_id,
    source_event_id: row.source_event_id,
    issue_id: row.issue_id,
    project_id: row.project_id,
    run_id: row.run_id,
    type: row.event_type,
    raw_method: row.raw_method,
    payload: row.summary_payload,
    summary: row.summary,
    source_payload_bytes: row.source_payload_bytes,
    source_sha256: row.source_sha256,
    summary_sha256: row.summary_sha256,
    policy_id: row.policy_id,
    retention_tier: row.retention_tier,
    projection_version: EVENT_SUMMARY_PROJECTOR_VERSION,
    created_at: row.event_created_at
  };
}
