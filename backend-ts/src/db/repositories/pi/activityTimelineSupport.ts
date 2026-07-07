import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";
import type { PiActivityFilter, PiActivityNode, PiActivityScope } from "./activityTimelineTypes.ts";

export const DEFAULT_ACTIVITY_LIMIT = 100;
export const MAX_ACTIVITY_LIMIT = 500;

export function addActivityRef(scope: PiActivityScope, ref: { id: number | string; kind: string }): void {
  if (ref.kind === "external_event") scope.rawEventIds.add(Number(ref.id));
  if (ref.kind === "attention_inbox_item") scope.inboxIds.add(Number(ref.id));
  if (ref.kind === "proposal") scope.proposalIds.add(String(ref.id));
  if (ref.kind === "issue") scope.issueIds.add(Number(ref.id));
}

export function externalEventIds(refs: string[]): number[] {
  return refs.map((ref) => /^external_event:(\d+)$/.exec(ref)?.[1]).filter(Boolean).map(Number);
}

export function refNumber(value: string): number {
  return Number(/^attention_inbox_item:(\d+)$/.exec(value)?.[1] ?? 0);
}

export function textRefs(text: string): Array<{ id: number | string; kind: string }> {
  const refs: Array<{ id: number | string; kind: string }> = [];
  for (const match of text.matchAll(/external_event:(\d+)/g)) refs.push({ kind: "external_event", id: Number(match[1]) });
  for (const match of text.matchAll(/attention_inbox_item:(\d+)/g)) refs.push({ kind: "attention_inbox_item", id: Number(match[1]) });
  for (const match of text.matchAll(/proposal:([A-Za-z0-9_.:-]+)/g)) refs.push({ kind: "proposal", id: match[1] });
  for (const match of text.matchAll(/issue:(\d+)/g)) refs.push({ kind: "issue", id: Number(match[1]) });
  return refs;
}

export function refNodeID(ref: { id: number | string; kind: string }): string {
  if (ref.kind === "attention_inbox_item") return `inbox_item:${ref.id}`;
  if (ref.kind === "external_event") return `raw_event:${ref.id}`;
  if (ref.kind === "proposal") return `proposal:${ref.id}`;
  if (ref.kind === "issue") return `issue:${ref.id}`;
  return "";
}

export function node(kind: string, id: string, at: string, status: string, title: string, summary: string, links: Record<string, string>, refs: Record<string, unknown>, parentIds: string[] = [], decision = ""): PiActivityNode {
  return {
    at,
    decision: decision || undefined,
    id,
    kind,
    links,
    parent_ids: [...new Set(parentIds.filter((item) => item && !item.endsWith(":0")))],
    refs: cleanRefs(refs),
    stage: stageLabel(kind),
    status: clean(status) || "recorded",
    summary: textSummary(summary),
    title: textSummary(title)
  };
}

export function inWindow(value: string, since: string | undefined, until: string | undefined): boolean {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return true;
  const start = timeValue(since);
  const end = timeValue(until);
  return (start === 0 || at >= start) && (end === 0 || at <= end);
}

export function compareNodes(left: PiActivityNode, right: PiActivityNode): number {
  const diff = timeValue(left.at) - timeValue(right.at);
  if (diff !== 0) return diff;
  const stageDiff = stageOrder(left.kind) - stageOrder(right.kind);
  return stageDiff || left.id.localeCompare(right.id);
}

export function jsonSummary(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return truncate(redactAuditJsonText(text).replace(/\s+/g, " ").trim(), 360);
}

export function publicFilters(filter: PiActivityFilter): Record<string, unknown> {
  return cleanRefs({
    inbox_item_id: filter.inboxItemId,
    issue_id: filter.issueId,
    limit: resultLimit(filter.limit),
    proposal_id: clean(filter.proposalId),
    since: clean(filter.since),
    source: clean(filter.source),
    until: clean(filter.until)
  });
}

export function resultLimit(value: unknown): number {
  const parsed = positiveNumber(value);
  return parsed > 0 ? Math.min(parsed, MAX_ACTIVITY_LIMIT) : DEFAULT_ACTIVITY_LIMIT;
}

export function positiveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function cleanRefs(refs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(refs).filter(([, value]) => value !== undefined && value !== "" && value !== 0));
}

function timeValue(value: string | undefined): number {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stageOrder(kind: string): number {
  return ["raw_event", "context_bundle", "intake_run", "inbox_item", "domain_skill", "action_proposal", "policy_decision", "tool_call", "action_event", "pi_action", "issue", "session", "reply", "issue_event"].indexOf(kind) + 1;
}

function stageLabel(kind: string): string {
  return ({ action_event: "Action Event", action_proposal: "Proposal", context_bundle: "Context", domain_skill: "Domain Skill", inbox_item: "Inbox", intake_run: "Intake", issue: "Issue", issue_event: "Issue Event", pi_action: "Action", policy_decision: "Policy", raw_event: "Raw", reply: "Reply", session: "Session", tool_call: "Tool Call" } as Record<string, string>)[kind] || kind;
}

function textSummary(value: unknown): string {
  return truncate(redactAuditText(clean(value)).replace(/\s+/g, " ").trim(), 360);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
