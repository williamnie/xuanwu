import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { queryEventSummaries } from "../../events/eventSummaryQuery.ts";
import { issueIDToWorkID, workIDToIssueID } from "./issueAdapter.ts";
import type { WorkID } from "./contracts.ts";
import {
  type WorkTimelineQuery,
  type WorkTimelineResult,
  timelineLimit,
  dedupeNodes,
  compareTimelineNodes,
  isOlderThanCursor,
  WORK_TIMELINE_SCHEMA_VERSION,
  pageSummary,
  type WorkTimelineNode,
  type CursorPosition,
  canonicalTimestamp
} from "./timelineModel.ts";
import { issueEventNodes, runNodes, piActionEventNodes, approvalNodes } from "./timelineNodes.ts";

/**
 * Canonical read projection for Work history. Existing Issue/Run/PI tables remain
 * authoritative; this function never writes a second timeline store.
 */
export function queryWorkTimeline(
  db: RunnerDatabase,
  workID: WorkID,
  input: WorkTimelineQuery = {}
): WorkTimelineResult {
  const issueID = workIDToIssueID(workID);
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Work ${workID} not found`);
  const canonicalWorkID = issueIDToWorkID(issue.id);
  if (canonicalWorkID !== workID) throw new Error(`Work ${workID} is not canonical`);

  const limit = timelineLimit(input.limit);
  const cursor = input.cursor ? decodeWorkTimelineCursor(input.cursor) : undefined;
  const issueProjection = queryEventSummaries(db, { issueID });
  const candidates = dedupeNodes([
    ...issueProjection.items.flatMap((event) => issueEventNodes(workID, issueID, event)),
    ...listIssueRuns(db, issueID).flatMap((run) => runNodes(workID, issueID, run)),
    ...piActionEventNodes(db, workID, issueID),
    ...approvalNodes(db, workID, issueID)
  ]).sort(compareTimelineNodes);
  const eligible = cursor ? candidates.filter((node) => isOlderThanCursor(node, cursor)) : candidates;
  const page = eligible.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const items = page.slice(0, limit);

  return {
    has_more: hasMore,
    items,
    limit,
    next_cursor: hasMore && items.length > 0 ? encodeWorkTimelineCursor(items.at(-1)!) : "",
    schema_version: WORK_TIMELINE_SCHEMA_VERSION,
    source_of_truth: {
      approval: "pi_approval_requests",
      evidence: "issue_events+pi_action_events",
      handoff: "derived-from-authoritative-events",
      issue_events: "issue_events-via-event_summary_projection",
      runs: "issue_runs",
      work: "issues",
      work_events: "work_events-audit-only-before-G4"
    },
    summary_projection: pageSummary(items, issueProjection.watermark.status),
    work_id: workID
  };
}

function encodeWorkTimelineCursor(node: Pick<WorkTimelineNode, "id" | "occurred_at">): string {
  const position: CursorPosition = { at: canonicalTimestamp(node.occurred_at), id: node.id, version: 1 };
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeWorkTimelineCursor(value: string): CursorPosition {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2048) {
    throw new Error("Work timeline cursor is invalid");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPosition>;
    if (parsed.version !== 1 || typeof parsed.id !== "string" || !parsed.id.startsWith("timeline:") ||
        typeof parsed.at !== "string" || canonicalTimestamp(parsed.at) !== parsed.at) {
      throw new Error("invalid cursor payload");
    }
    return parsed as CursorPosition;
  } catch {
    throw new Error("Work timeline cursor is invalid");
  }
}

export type { WorkTimelineNode } from "./timelineModel.ts";
