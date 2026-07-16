import type { RunnerDatabase } from "../../db/database.ts";
import { listWorkEvents, type WorkEvent } from "../../db/repositories/workLedger.ts";
import { getIssue, listIssueRuns, type IssueRun } from "../../db/repositories/issues.ts";
import { listPiActionEvents, type PiActionEvent } from "../../db/repositories/pi/actions.ts";
import {
  listPiApprovalRequests,
  type PiApprovalRequest
} from "../../db/repositories/pi/approvalRequests.ts";
import { redactAuditJsonText, redactAuditText } from "../../db/repositories/pi/auditRedaction.ts";
import { queryEventSummaries, type PublicEventSummary } from "../../events/eventSummaryQuery.ts";
import { issueIDToWorkID, workIDToIssueID } from "./issueAdapter.ts";
import { listPiWorkRelations } from "./piRelationAdapter.ts";
import type { WorkID } from "./contracts.ts";

export const WORK_TIMELINE_SCHEMA_VERSION = "xuanwu.work-timeline.v1" as const;
export const WORK_TIMELINE_NODE_KINDS = [
  "work_event",
  "issue_event",
  "run",
  "evidence",
  "handoff",
  "approval"
] as const;

export type WorkTimelineNodeKind = typeof WORK_TIMELINE_NODE_KINDS[number];
export type WorkTimelineSourceAuthority =
  | "work_events"
  | "issue_events"
  | "issue_runs"
  | "pi_action_events"
  | "pi_approval_requests";

export type WorkTimelineSourceLink = {
  href: string;
  rel: "work" | "issue" | "run" | "session" | "source" | "summary";
};

export type WorkTimelineNode = {
  dedupe_key: string;
  event_name: string;
  id: string;
  kind: WorkTimelineNodeKind;
  occurred_at: string;
  payload: Record<string, unknown>;
  source: {
    authority: WorkTimelineSourceAuthority;
    external_id: string;
    projection: "authority" | "derived" | "summary";
  };
  source_links: WorkTimelineSourceLink[];
  status: string;
  summary: string;
  title: string;
  work_id: WorkID;
};

export type WorkTimelineQuery = {
  cursor?: string;
  limit?: number;
};

export type WorkTimelineResult = {
  has_more: boolean;
  items: WorkTimelineNode[];
  limit: number;
  next_cursor: string;
  schema_version: typeof WORK_TIMELINE_SCHEMA_VERSION;
  source_of_truth: {
    approval: "pi_approval_requests";
    evidence: "issue_events+pi_action_events";
    handoff: "derived-from-authoritative-events";
    issue_events: "issue_events-via-event_summary_projection";
    runs: "issue_runs";
    work: "issues";
    work_events: "work_events-audit-only-before-G4";
  };
  summary_projection: {
    counts_by_kind: Partial<Record<WorkTimelineNodeKind, number>>;
    issue_event_projection_status: string;
    latest_occurred_at: string;
    scope: "page";
  };
  work_id: WorkID;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const EVIDENCE_ISSUE_EVENT_TYPES = new Set([
  "issue.log",
  "issue.verification_report",
  "issue.verification_reviewed"
]);

type CursorPosition = { at: string; id: string; version: 1 };

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
    ...listWorkEvents(db, workID).map((event) => workEventNode(workID, issueID, event)),
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

export function encodeWorkTimelineCursor(node: Pick<WorkTimelineNode, "id" | "occurred_at">): string {
  const position: CursorPosition = { at: canonicalTimestamp(node.occurred_at), id: node.id, version: 1 };
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

export function decodeWorkTimelineCursor(value: string): CursorPosition {
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

function workEventNode(workID: WorkID, issueID: number, event: WorkEvent): WorkTimelineNode {
  return timelineNode({
    eventName: event.event_type,
    externalID: event.event_id,
    issueID,
    kind: "work_event",
    occurredAt: event.occurred_at,
    payload: {
      ...event.payload,
      actor: event.actor,
      after_revision: event.after_revision,
      before_revision: event.before_revision,
      correlation_id: event.correlation_id,
      gate: event.gate,
      outcome: event.outcome,
      reason: event.reason
    },
    projection: "authority",
    sourceAuthority: "work_events",
    status: event.outcome,
    summary: event.reason,
    title: event.event_type,
    workID
  });
}

function issueEventNodes(workID: WorkID, issueID: number, event: PublicEventSummary): WorkTimelineNode[] {
  const payload = jsonObject(event.payload);
  const status = text(payload.status) || event.type;
  if (event.type === "issue.status_changed" && status === "pending_verification") {
    return [timelineNode({
      eventName: "handoff.prepared.v1",
      externalID: String(event.source_event_id),
      issueID,
      kind: "handoff",
      occurredAt: event.created_at,
      payload: {
        ...payload,
        issue_event_type: event.type,
        projection_completeness: "legacy_incomplete",
        source_sha256: event.source_sha256
      },
      projection: "derived",
      sourceAuthority: "issue_events",
      status: "draft",
      summary: event.summary || "Work is pending verification",
      title: "Handoff prepared",
      workID
    })];
  }
  const kind = issueEventKind(event.type);
  return [timelineNode({
    eventName: issueEventName(event.type),
    externalID: String(event.source_event_id),
    issueID,
    kind,
    occurredAt: event.created_at,
    payload: {
      ...payload,
      issue_event_type: event.type,
      policy_id: event.policy_id,
      retention_tier: event.retention_tier,
      run_id: event.run_id,
      source_sha256: event.source_sha256,
      summary_sha256: event.summary_sha256
    },
    projection: "summary",
    sourceAuthority: "issue_events",
    status,
    summary: event.summary || event.type,
    title: event.type,
    workID
  })];
}

function runNodes(workID: WorkID, issueID: number, run: IssueRun): WorkTimelineNode[] {
  const common = {
    issueID,
    payload: {
      attempt: run.attempt,
      provider: run.provider,
      provider_session_id: run.provider_session_id,
      provider_turn_id: run.provider_turn_id,
      raw_status: run.status
    },
    sourceAuthority: "issue_runs" as const,
    workID
  };
  const started = timelineNode({
    ...common,
    eventName: "run.created.v1",
    externalID: run.id,
    nodeKey: `${run.id}:started`,
    occurredAt: run.started_at,
    kind: "run",
    projection: "authority",
    status: "running",
    summary: run.selection_reason || `${run.provider} attempt ${run.attempt} started`,
    title: `Run ${run.attempt} started`
  });
  if (!run.ended_at) return [withSessionLink(started, run)];
  return [withSessionLink(started, run), withSessionLink(timelineNode({
    ...common,
    eventName: "run.status_changed.v1",
    externalID: run.id,
    nodeKey: `${run.id}:ended`,
    occurredAt: run.ended_at,
    kind: "run",
    payload: { ...common.payload, error: run.error, exit_reason: run.exit_reason },
    projection: "authority",
    status: domainRunStatus(run.status),
    summary: run.error || run.exit_reason || `${run.provider} attempt ${run.attempt} ended`,
    title: `Run ${run.attempt} ended`
  }), run)];
}

function piActionEventNodes(db: RunnerDatabase, workID: WorkID, issueID: number): WorkTimelineNode[] {
  const actionIDs = listPiWorkRelations(db, { work_id: workID }).relations.flatMap((relation) => {
    const refs = relation.source_ref.related_refs
      .filter((ref) => ref.authority === "pi_actions")
      .map((ref) => ref.external_id);
    if (relation.source_ref.authority === "pi_actions") refs.push(relation.source_ref.external_id);
    return refs;
  });
  const events = [
    ...listPiActionEvents(db, { issueId: issueID }),
    ...actionIDs.flatMap((actionID) => listPiActionEvents(db, { actionId: actionID }))
  ];
  return dedupe(events, (event) => String(event.id)).map((event) => piActionEventNode(workID, issueID, event));
}

function piActionEventNode(workID: WorkID, issueID: number, event: PiActionEvent): WorkTimelineNode {
  return timelineNode({
    eventName: "evidence.recorded.v1",
    externalID: String(event.id),
    issueID,
    kind: "evidence",
    occurredAt: event.created_at,
    payload: {
      ...jsonObject(event.payload_json),
      action_id: event.action_id,
      actor: event.actor,
      decision: event.decision,
      event_type: event.event_type,
      result: jsonObject(event.result_json)
    },
    projection: "authority",
    sourceAuthority: "pi_action_events",
    status: event.decision || event.event_type,
    summary: event.reason || event.error || event.event_type,
    title: `PI action ${event.event_type}`,
    workID
  });
}

function approvalNodes(db: RunnerDatabase, workID: WorkID, issueID: number): WorkTimelineNode[] {
  const runs = listIssueRuns(db, issueID);
  const requests = [
    ...listPiApprovalRequests(db, { issueId: issueID }),
    ...runs.flatMap((run) => listPiApprovalRequests(db, { runId: run.id }))
  ];
  return dedupe(requests, (request) => request.approval_id).flatMap((request) => (
    approvalRequestNodes(workID, issueID, request)
  ));
}

function approvalRequestNodes(workID: WorkID, issueID: number, request: PiApprovalRequest): WorkTimelineNode[] {
  const common = {
    issueID,
    kind: "approval" as const,
    sourceAuthority: "pi_approval_requests" as const,
    workID
  };
  const requested = timelineNode({
    ...common,
    eventName: "attention.opened.v1",
    externalID: request.approval_id,
    nodeKey: `${request.approval_id}:requested`,
    occurredAt: request.created_at,
    payload: approvalPayload(request),
    projection: "authority",
    status: "pending",
    summary: request.summary || request.request_summary || request.request_type,
    title: `Approval requested: ${request.request_type || request.approval_id}`
  });
  if (!request.resolved_at) return [requested];
  return [requested, timelineNode({
    ...common,
    eventName: "attention.status_changed.v1",
    externalID: request.approval_id,
    nodeKey: `${request.approval_id}:resolved`,
    occurredAt: request.resolved_at,
    payload: approvalPayload(request),
    projection: "authority",
    status: request.status,
    summary: request.resolved_decision || request.decision || request.status,
    title: `Approval resolved: ${request.request_type || request.approval_id}`
  })];
}

function approvalPayload(request: PiApprovalRequest): Record<string, unknown> {
  return {
    approval_id: request.approval_id,
    approval_source: request.approval_source,
    decision: request.decision,
    delivery_state: request.delivery_state,
    provider: request.provider,
    request_type: request.request_type,
    resolved_decision: request.resolved_decision,
    resolved_scope: request.resolved_scope,
    risk: request.risk,
    run_id: request.run_id,
    status: request.status
  };
}

function timelineNode(input: {
  eventName: string;
  externalID: string;
  issueID: number;
  kind: WorkTimelineNodeKind;
  nodeKey?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  projection: WorkTimelineNode["source"]["projection"];
  sourceAuthority: WorkTimelineSourceAuthority;
  status: string;
  summary: string;
  title: string;
  workID: WorkID;
}): WorkTimelineNode {
  const id = timelineNodeID(input.sourceAuthority, input.nodeKey ?? input.externalID, input.kind);
  return {
    dedupe_key: id,
    event_name: input.eventName,
    id,
    kind: input.kind,
    occurred_at: canonicalTimestamp(input.occurredAt),
    payload: redactedPayload(input.payload),
    source: {
      authority: input.sourceAuthority,
      external_id: input.externalID,
      projection: input.projection
    },
    source_links: sourceLinks(input.workID, input.issueID, input.sourceAuthority, input.externalID),
    status: cleanText(input.status) || "recorded",
    summary: cleanText(input.summary),
    title: cleanText(input.title),
    work_id: input.workID
  };
}

function withSessionLink(node: WorkTimelineNode, run: IssueRun): WorkTimelineNode {
  if (!run.provider_session_id) return node;
  const sessionID = `${run.provider}:${run.provider_session_id}`;
  return {
    ...node,
    source_links: [
      ...node.source_links,
      { href: `/api/sessions/${encodeURIComponent(sessionID)}`, rel: "session" }
    ]
  };
}

function sourceLinks(
  workID: WorkID,
  issueID: number,
  authority: WorkTimelineSourceAuthority,
  externalID: string
): WorkTimelineSourceLink[] {
  const links: WorkTimelineSourceLink[] = [
    { href: `/api/works/${encodeURIComponent(workID)}`, rel: "work" },
    { href: `/api/issues/${issueID}`, rel: "issue" }
  ];
  if (authority === "issue_events") {
    const sourceID = Number(externalID);
    if (Number.isSafeInteger(sourceID) && sourceID > 0) {
      links.push({ href: `/api/issues/${issueID}/events?before_id=${sourceID + 1}&limit=1`, rel: "source" });
      links.push({ href: `/api/issues/${issueID}/event-summaries?before_id=${sourceID + 1}&limit=1`, rel: "summary" });
    }
  } else if (authority === "issue_runs") {
    links.push({ href: `/api/issues/${issueID}/runs`, rel: "run" });
  } else if (authority === "pi_action_events") {
    links.push({ href: `/api/pi/activity?issue_id=${issueID}`, rel: "source" });
  } else if (authority === "pi_approval_requests") {
    links.push({ href: `/api/pi/approval-requests?issue_id=${issueID}`, rel: "source" });
  } else {
    links.push({ href: `/api/works/${encodeURIComponent(workID)}/timeline`, rel: "source" });
  }
  return links;
}

function timelineNodeID(authority: WorkTimelineSourceAuthority, externalID: string, kind: WorkTimelineNodeKind): string {
  return `timeline:${kind}:${authority}:${encodeURIComponent(externalID)}`;
}

function issueEventKind(type: string): WorkTimelineNodeKind {
  if (type === "issue.created" || type === "issue.status_changed") return "work_event";
  if (EVIDENCE_ISSUE_EVENT_TYPES.has(type)) return "evidence";
  return "issue_event";
}

function issueEventName(type: string): string {
  if (type === "issue.created") return "work.created.v1";
  if (type === "issue.status_changed") return "work.status_changed.v1";
  if (EVIDENCE_ISSUE_EVENT_TYPES.has(type)) return "evidence.recorded.v1";
  return type;
}

function domainRunStatus(status: string): string {
  if (["done", "pending_verification", "succeeded", "success"].includes(status)) return "succeeded";
  if (["cancelled", "canceled", "todo", "triage"].includes(status)) return "cancelled";
  if (["failed", "error"].includes(status)) return "failed";
  return status || "succeeded";
}

function compareTimelineNodes(left: WorkTimelineNode, right: WorkTimelineNode): number {
  return right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id);
}

function isOlderThanCursor(node: WorkTimelineNode, cursor: CursorPosition): boolean {
  return node.occurred_at < cursor.at || (node.occurred_at === cursor.at && node.id < cursor.id);
}

function dedupeNodes(nodes: WorkTimelineNode[]): WorkTimelineNode[] {
  return dedupe(nodes, (node) => node.dedupe_key);
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function pageSummary(
  items: WorkTimelineNode[],
  projectionStatus: string
): WorkTimelineResult["summary_projection"] {
  const counts: Partial<Record<WorkTimelineNodeKind, number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return {
    counts_by_kind: counts,
    issue_event_projection_status: projectionStatus,
    latest_occurred_at: items[0]?.occurred_at ?? "",
    scope: "page"
  };
}

function timelineLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) {
    throw new Error(`Work timeline limit must be between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function canonicalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Work timeline source timestamp is invalid");
  return new Date(time).toISOString();
}

function redactedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return jsonObject(redactAuditJsonText(JSON.stringify(payload)));
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanText(value: unknown): string {
  return redactAuditText(typeof value === "string" ? value.trim() : "");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
