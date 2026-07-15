import type { RunnerDatabase } from "../../database.ts";
import { queryEventSummaries } from "../../../events/eventSummaryQuery.ts";
import { listIssueRuns } from "../issues.ts";
import { listPiActionEvents, type PiAction, type PiActionEvent } from "./actions.ts";
import type { ActionProposalRecord } from "./actionProposals.ts";
import type { PiActivityRows } from "./activityTimelineScope.ts";
import type { PiActivityNode, PiActivityScope } from "./activityTimelineTypes.ts";
import { dedupeBy, jsonSummary, node, refNodeID, refNumber, textRefs } from "./activityTimelineSupport.ts";

const POLICY_EVENT_TYPES = new Set(["approval_decision", "gate_decision", "pending_approval", "source_policy_decision"]);

export function buildPiActivityNodes(db: RunnerDatabase, rows: PiActivityRows, scope: PiActivityScope): PiActivityNode[] {
  const nodes: PiActivityNode[] = [];
  for (const event of rows.rawEvents) if (scope.rawEventIds.has(event.id)) nodes.push(rawNode(event));
  for (const bundle of rows.bundles) if (scope.bundleIds.has(bundle.id)) nodes.push(bundleNode(bundle));
  for (const run of rows.intakeRuns) if (scope.intakeRunIds.has(run.id)) nodes.push(intakeNode(run));
  for (const item of rows.inboxItems) if (scope.inboxIds.has(item.id)) nodes.push(inboxNode(item));
  for (const action of rows.actions) if (scope.actionIds.has(action.id)) nodes.push(actionNode(action));
  for (const event of scopedActionEvents(db, scope)) nodes.push(actionEventNode(event));
  for (const proposal of rows.proposals) if (scope.proposalIds.has(proposal.id)) nodes.push(proposalNode(proposal));
  for (const issue of rows.issues) if (issue && scope.issueIds.has(issue.id)) nodes.push(issueNode(issue));
  for (const issueID of scope.issueIds) nodes.push(...issueChildNodes(db, issueID));
  for (const reply of rows.replies) if (replyIncluded(scope, reply)) nodes.push(replyNode(reply));
  for (const outbox of rows.syncOutbox) if (scope.actionIds.has(outbox.approval_action_id)) nodes.push(outboxNode(outbox));
  return dedupeBy(nodes, (item) => item.id);
}

function rawNode(event: PiActivityRows["rawEvents"][number]): PiActivityNode {
  return node("raw_event", `raw_event:${event.id}`, event.received_at, event.status, `Raw event #${event.id}`, event.content, {
    detail: `/api/pi/attention-inbox/raw-events/${event.id}`
  }, { external_event_id: event.id, external_id: event.external_id, source: event.source });
}

function bundleNode(bundle: PiActivityRows["bundles"][number]): PiActivityNode {
  return node("context_bundle", `context_bundle:${bundle.id}`, bundle.created_at, bundle.trigger, `Context bundle #${bundle.id}`, bundle.reason, {
    detail: `/api/pi/attention-inbox/context-bundles/${bundle.id}`
  }, { bundle_id: bundle.id, source: bundle.source }, bundle.event_refs.map((id) => `raw_event:${id}`));
}

function intakeNode(run: PiActivityRows["intakeRuns"][number]): PiActivityNode {
  return node("intake_run", `intake_run:${run.id}`, run.updated_at, run.status, `Intake run #${run.id}`, run.error || jsonSummary(run.schema_output), {
    detail: `/api/pi/attention-inbox/intake-runs/${run.id}`
  }, { bundle_id: run.bundle_id, intake_run_id: run.id, skill_id: run.skill_id }, [`context_bundle:${run.bundle_id}`]);
}

function inboxNode(item: PiActivityRows["inboxItems"][number]): PiActivityNode {
  return node("inbox_item", `inbox_item:${item.id}`, item.created_at, item.status, item.title, item.summary, {
    detail: `/api/pi/attention-inbox/items/${item.id}`
  }, { bundle_id: item.bundle_id, inbox_item_id: item.id, intent: item.primary_intent }, [`intake_run:${item.intake_run_id}`]);
}

function proposalNode(proposal: ActionProposalRecord): PiActivityNode {
  return node("action_proposal", `proposal:${proposal.id}`, proposal.updated_at, proposal.status, proposal.summary, actionList(proposal.actions), {
    detail: `/api/pi/action-proposals/${encodeURIComponent(proposal.id)}`
  }, { proposal_id: proposal.id, skill_run_id: proposal.skill_run_id }, proposal.source_item_ids.map((id) => `inbox_item:${refNumber(id)}`).filter(Boolean));
}

function actionNode(action: PiAction): PiActivityNode {
  const kind = action.action_type === "attention_inbox.domain_skill" ? "domain_skill" : "pi_action";
  return node(kind, `${kind}:${action.id}`, action.updated_at, action.status, action.action_type, action.rationale || jsonSummary(action.payload_json), {
    detail: `/api/pi/actions/${encodeURIComponent(action.id)}`,
    events: `/api/pi/actions/${encodeURIComponent(action.id)}/events`
  }, { action_id: action.id, action_type: action.action_type, gate_decision: action.gate_decision, issue_id: action.issue_id || undefined, risk_level: action.risk_level }, actionParents(action), action.gate_decision);
}

function actionEventNode(event: PiActionEvent): PiActivityNode {
  const kind = actionEventKind(event);
  return node(kind, `${kind}:${event.id}`, event.created_at, event.decision || event.event_type, event.event_type, eventSummary(event), {
    action: `/api/pi/actions/${encodeURIComponent(event.action_id)}`,
    events: `/api/pi/actions/${encodeURIComponent(event.action_id)}/events`
  }, { action_id: event.action_id, event_id: event.id, issue_id: event.issue_id || undefined }, [`pi_action:${event.action_id}`], event.decision);
}

function eventSummary(event: PiActionEvent): string {
  return event.reason || event.error || nonEmptyJsonSummary(event.payload_json) || jsonSummary(event.result_json);
}

function nonEmptyJsonSummary(value: string): string {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonSummary(value);
    return Object.keys(parsed).length > 0 ? jsonSummary(value) : "";
  } catch {
    return jsonSummary(value);
  }
}

function actionEventKind(event: PiActionEvent): string {
  if (event.event_type === "tool_call_audit") return "tool_call";
  if (POLICY_EVENT_TYPES.has(event.event_type)) return "policy_decision";
  return "action_event";
}

function issueNode(issue: NonNullable<PiActivityRows["issues"][number]>): PiActivityNode {
  return node("issue", `issue:${issue.id}`, issue.updated_at, issue.status, `Issue #${issue.id}: ${issue.title}`, issue.error || issue.source_excerpt || issue.description, {
    detail: `/api/issues/${issue.id}`,
    events: `/api/issues/${issue.id}/events`,
    runs: `/api/issues/${issue.id}/runs`
  }, { issue_id: issue.id, project_id: issue.project_id, source_turn_id: issue.source_turn_id });
}

function issueChildNodes(db: RunnerDatabase, issueID: number): PiActivityNode[] {
  const events = safeIssueEvents(db, issueID).map((event) => node("issue_event", `issue_event:${event.id}`, event.created_at, event.type, event.type, event.payload, {
    issue: `/api/issues/${issueID}`,
    events: `/api/issues/${issueID}/events`
  }, { issue_event_id: event.id, issue_id: issueID }, [`issue:${issueID}`]));
  const runs = listIssueRuns(db, issueID).map((run) => node("session", `issue_run:${run.id}`, run.ended_at || run.started_at, run.status, `Session ${run.provider}:${run.provider_session_id || run.id}`, run.error || run.exit_reason || run.selection_reason, {
    issue: `/api/issues/${issueID}`,
    runs: `/api/issues/${issueID}/runs`
  }, { issue_id: issueID, provider: run.provider, run_id: run.id, session_id: run.provider_session_id }, [`issue:${issueID}`]));
  return [...events, ...runs];
}

function replyNode(reply: PiActivityRows["replies"][number]): PiActivityNode {
  return node("reply", `reply_draft:${reply.id}`, reply.updated_at, reply.status, `Reply draft #${reply.id}`, reply.content, {
    detail: `/api/im-reply-drafts/${reply.id}`
  }, { approval_action_id: reply.approval_action_id, external_event_id: reply.external_event_id, issue_id: reply.issue_id, source: reply.source }, [`pi_action:${reply.approval_action_id}`]);
}

function outboxNode(outbox: PiActivityRows["syncOutbox"][number]): PiActivityNode {
  return node("reply", `sync_outbox:${outbox.id}`, outbox.updated_at, outbox.status, `Sync outbox #${outbox.id}`, outbox.last_error || outbox.content, {
    list: `/api/sync-outbox?source=${encodeURIComponent(outbox.source)}`
  }, { approval_action_id: outbox.approval_action_id, issue_id: outbox.issue_id, source: outbox.source }, [`reply_draft:${outbox.reply_draft_id}`]);
}

function scopedActionEvents(db: RunnerDatabase, scope: PiActivityScope): PiActionEvent[] {
  const events: PiActionEvent[] = [];
  for (const actionID of scope.actionIds) events.push(...listPiActionEvents(db, { actionId: actionID }));
  for (const issueID of scope.issueIds) events.push(...listPiActionEvents(db, { issueId: issueID }));
  return dedupeBy(events, (event) => String(event.id));
}

function actionParents(action: PiAction): string[] {
  return textRefs(`${action.payload_json}\n${action.rationale}`).map(refNodeID).filter(Boolean);
}

function replyIncluded(scope: PiActivityScope, reply: PiActivityRows["replies"][number]): boolean {
  return scope.actionIds.has(reply.approval_action_id) || scope.rawEventIds.has(reply.external_event_id) || scope.issueIds.has(reply.issue_id);
}

function safeIssueEvents(db: RunnerDatabase, issueID: number) {
  try { return queryEventSummaries(db, { issueID, limit: 500 }).items; } catch { return []; }
}

function actionList(actions: ActionProposalRecord["actions"]): string {
  return actions.map((action) => `${action.type}:${action.execution_status || "pending"}`).join(" · ");
}
