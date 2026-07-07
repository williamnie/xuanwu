import type { RunnerDatabase } from "../../database.ts";
import { listContextBundles } from "../contextBundles.ts";
import { listExternalEvents } from "../externalEvents.ts";
import { getAttentionInboxItem, listAttentionInboxItems, listIntakeRuns } from "../intakeRuns.ts";
import { listImReplyDrafts, listSyncOutbox } from "../imReplyOutbox.ts";
import { getIssue, listIssues } from "../issues.ts";
import { getActionProposal, listActionProposals, type ActionProposalRecord } from "./actionProposals.ts";
import { listPiActions, type PiAction } from "./actions.ts";
import { emptyActivityScope, type PiActivityFilter, type PiActivityScope } from "./activityTimelineTypes.ts";
import { addActivityRef, clean, DEFAULT_ACTIVITY_LIMIT, externalEventIds, positiveNumber, refNumber, textRefs } from "./activityTimelineSupport.ts";

export type PiActivityRows = ReturnType<typeof loadPiActivityRows>;

export function loadPiActivityRows(db: RunnerDatabase, filter: PiActivityFilter) {
  const source = clean(filter.source);
  return {
    actions: listPiActions(db),
    bundles: listContextBundles(db, source, 500),
    inboxItems: listAttentionInboxItems(db, { limit: 500, source }),
    intakeRuns: listIntakeRuns(db, { limit: 500 }),
    issues: filter.issueId ? [getIssue(db, filter.issueId)].filter(Boolean) : listIssues(db),
    proposals: listActionProposals(db),
    rawEvents: listExternalEvents(db, { limit: 500, source }),
    replies: listImReplyDrafts(db, { source }),
    syncOutbox: listSyncOutbox(db, { source })
  };
}

export function buildPiActivityScope(db: RunnerDatabase, rows: PiActivityRows, filter: PiActivityFilter): PiActivityScope {
  const scope = emptyActivityScope(clean(filter.source));
  if (!hasNarrowFilter(filter)) seedRecent(rows, scope);
  if (scope.source !== "") seedSource(rows, scope);
  if (filter.inboxItemId) addInbox(scope, getAttentionInboxItem(db, filter.inboxItemId));
  if (filter.proposalId) addProposal(scope, getActionProposal(db, filter.proposalId));
  if (filter.issueId) addIssue(scope, getIssue(db, filter.issueId));
  expandScope(rows, scope);
  return scope;
}

function seedRecent(rows: PiActivityRows, scope: PiActivityScope): void {
  for (const event of rows.rawEvents) scope.rawEventIds.add(event.id);
  for (const bundle of rows.bundles) scope.bundleIds.add(bundle.id);
  for (const run of rows.intakeRuns) scope.intakeRunIds.add(run.id);
  for (const item of rows.inboxItems) scope.inboxIds.add(item.id);
  for (const proposal of rows.proposals.slice(0, DEFAULT_ACTIVITY_LIMIT)) scope.proposalIds.add(proposal.id);
  for (const action of rows.actions.slice(0, DEFAULT_ACTIVITY_LIMIT)) scope.actionIds.add(action.id);
}

function seedSource(rows: PiActivityRows, scope: PiActivityScope): void {
  for (const event of rows.rawEvents.filter((row) => row.source === scope.source)) scope.rawEventIds.add(event.id);
  for (const bundle of rows.bundles.filter((row) => row.source === scope.source)) scope.bundleIds.add(bundle.id);
  for (const item of rows.inboxItems.filter((row) => row.source === scope.source)) scope.inboxIds.add(item.id);
  for (const reply of rows.replies.filter((row) => row.source === scope.source)) scope.actionIds.add(reply.approval_action_id);
}

function expandScope(rows: PiActivityRows, scope: PiActivityScope): void {
  for (let pass = 0; pass < 5; pass += 1) {
    const before = scopeSize(scope);
    for (const event of rows.rawEvents) if (scope.rawEventIds.has(event.id) || event.source === scope.source) scope.rawEventIds.add(event.id);
    for (const bundle of rows.bundles) expandBundle(scope, bundle);
    for (const run of rows.intakeRuns) expandIntakeRun(scope, run);
    for (const item of rows.inboxItems) expandInboxItem(scope, item);
    for (const proposal of rows.proposals) expandProposal(scope, proposal);
    for (const action of rows.actions) expandAction(scope, action);
    for (const issue of rows.issues) if (issue) expandIssue(scope, issue);
    for (const reply of rows.replies) expandReply(scope, reply);
    if (scopeSize(scope) === before) return;
  }
}

function expandBundle(scope: PiActivityScope, bundle: PiActivityRows["bundles"][number]): void {
  if (!scope.bundleIds.has(bundle.id) && !bundle.event_refs.some((id) => scope.rawEventIds.has(id))) return;
  scope.bundleIds.add(bundle.id);
  for (const id of bundle.event_refs) scope.rawEventIds.add(id);
}

function expandIntakeRun(scope: PiActivityScope, run: PiActivityRows["intakeRuns"][number]): void {
  if (!scope.intakeRunIds.has(run.id) && !scope.bundleIds.has(run.bundle_id)) return;
  scope.intakeRunIds.add(run.id);
  scope.bundleIds.add(run.bundle_id);
}

function expandInboxItem(scope: PiActivityScope, item: PiActivityRows["inboxItems"][number]): void {
  if (!scope.inboxIds.has(item.id) && !scope.intakeRunIds.has(item.intake_run_id) && !scope.bundleIds.has(item.bundle_id)) return;
  addInbox(scope, item);
}

function expandProposal(scope: PiActivityScope, proposal: ActionProposalRecord): void {
  const linked = scope.proposalIds.has(proposal.id) || proposal.source_item_ids.some((id) => scope.inboxIds.has(refNumber(id)));
  if (!linked) return;
  scope.proposalIds.add(proposal.id);
  if (proposal.skill_run_id) scope.actionIds.add(proposal.skill_run_id);
  for (const id of proposal.source_item_ids.map(refNumber).filter(Boolean)) scope.inboxIds.add(id);
  for (const id of externalEventIds(proposal.evidence_refs)) scope.rawEventIds.add(id);
  for (const action of proposal.actions) {
    if (action.pi_action_id) scope.actionIds.add(action.pi_action_id);
    addPossibleIssue(scope, action.payload.issue_id ?? action.result?.issue_id ?? action.result?.id);
  }
}

function expandAction(scope: PiActivityScope, action: PiAction): void {
  if (!scope.actionIds.has(action.id) && !(action.issue_id > 0 && scope.issueIds.has(action.issue_id))) return;
  scope.actionIds.add(action.id);
  addPossibleIssue(scope, action.issue_id);
  for (const ref of textRefs(`${action.payload_json}\n${action.result_json}\n${action.rationale}`)) addActivityRef(scope, ref);
}

function expandIssue(scope: PiActivityScope, issue: NonNullable<PiActivityRows["issues"][number]>): void {
  const refs = textRefs(`${issue.source_turn_id}\n${issue.source_excerpt}`);
  if (!scope.issueIds.has(issue.id) && !refs.some((ref) => refInScope(scope, ref))) return;
  scope.issueIds.add(issue.id);
  for (const ref of textRefs(`${issue.source_turn_id}\n${issue.source_excerpt}\n${issue.description}`)) addActivityRef(scope, ref);
}

function expandReply(scope: PiActivityScope, reply: PiActivityRows["replies"][number]): void {
  if (!scope.actionIds.has(reply.approval_action_id) && !scope.rawEventIds.has(reply.external_event_id) && !scope.issueIds.has(reply.issue_id)) return;
  if (reply.approval_action_id) scope.actionIds.add(reply.approval_action_id);
  addPossibleIssue(scope, reply.issue_id);
  if (reply.external_event_id > 0) scope.rawEventIds.add(reply.external_event_id);
}

function addInbox(scope: PiActivityScope, item: ReturnType<typeof getAttentionInboxItem>): void {
  if (!item) return;
  scope.inboxIds.add(item.id);
  scope.bundleIds.add(item.bundle_id);
  scope.intakeRunIds.add(item.intake_run_id);
  for (const id of externalEventIds(item.evidence_refs)) scope.rawEventIds.add(id);
}

function addProposal(scope: PiActivityScope, proposal: ReturnType<typeof getActionProposal>): void {
  if (!proposal) return;
  scope.proposalIds.add(proposal.id);
  if (proposal.skill_run_id) scope.actionIds.add(proposal.skill_run_id);
  for (const id of proposal.source_item_ids.map(refNumber).filter(Boolean)) scope.inboxIds.add(id);
}

function addIssue(scope: PiActivityScope, issue: ReturnType<typeof getIssue>): void {
  if (!issue) return;
  scope.issueIds.add(issue.id);
  for (const ref of textRefs(`${issue.source_turn_id}\n${issue.source_excerpt}`)) addActivityRef(scope, ref);
}

function addPossibleIssue(scope: PiActivityScope, value: unknown): void {
  const id = positiveNumber(value);
  if (id > 0) scope.issueIds.add(id);
}

function hasNarrowFilter(filter: PiActivityFilter): boolean {
  return clean(filter.source) !== "" || positiveNumber(filter.inboxItemId) > 0 ||
    positiveNumber(filter.issueId) > 0 || clean(filter.proposalId) !== "";
}

function scopeSize(scope: PiActivityScope): number {
  return scope.actionIds.size + scope.bundleIds.size + scope.inboxIds.size + scope.intakeRunIds.size +
    scope.issueIds.size + scope.proposalIds.size + scope.rawEventIds.size;
}

function refInScope(scope: PiActivityScope, ref: { id: number | string; kind: string }): boolean {
  if (ref.kind === "external_event") return scope.rawEventIds.has(Number(ref.id));
  if (ref.kind === "attention_inbox_item") return scope.inboxIds.has(Number(ref.id));
  if (ref.kind === "proposal") return scope.proposalIds.has(String(ref.id));
  return ref.kind === "issue" && scope.issueIds.has(Number(ref.id));
}
