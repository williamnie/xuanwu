import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueRuns, type IssueRun } from "../../db/repositories/issues.ts";
import {
  listPiActionEvents,
  listPiActionsReferencingIssue,
  type PiActionEvent
} from "../../db/repositories/pi/actions.ts";
import { listPiApprovalRequests, type PiApprovalRequest } from "../../db/repositories/pi/approvalRequests.ts";
import { type PublicEventSummary } from "../../events/eventSummaryQuery.ts";
import type { WorkID } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";
import {
  type WorkTimelineNode,
  jsonObject,
  issueEventKind,
  issueEventName,
  domainRunStatus,
  dedupe,
  type WorkTimelineNodeKind,
  type WorkTimelineSourceAuthority,
  timelineNodeID,
  canonicalTimestamp,
  redactedPayload,
  cleanText,
  type WorkTimelineSourceLink
} from "./timelineModel.ts";

export function issueEventNodes(workID: WorkID, issueID: number, event: PublicEventSummary): WorkTimelineNode[] {
  const payload = jsonObject(event.payload);
  const status = cleanString(payload.status) || event.type;
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

export function runNodes(workID: WorkID, issueID: number, run: IssueRun): WorkTimelineNode[] {
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

export function piActionEventNodes(db: RunnerDatabase, workID: WorkID, issueID: number): WorkTimelineNode[] {
  const actionIDs = listPiActionsReferencingIssue(db, issueID).map((action) => action.id);
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
    title: `Supervisor action ${event.event_type}`,
    workID
  });
}

export function approvalNodes(db: RunnerDatabase, workID: WorkID, issueID: number): WorkTimelineNode[] {
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
