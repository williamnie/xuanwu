import { redactAuditJsonText, redactAuditText } from "../../db/repositories/pi/auditRedaction.ts";
import type { WorkID } from "./contracts.ts";

export const WORK_TIMELINE_SCHEMA_VERSION = "xuanwu.work-timeline.v1" as const;

const WORK_TIMELINE_NODE_KINDS = [
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
  "issue.log"
]);

export type CursorPosition = { at: string; id: string; version: 1 };

export function timelineNodeID(authority: WorkTimelineSourceAuthority, externalID: string, kind: WorkTimelineNodeKind): string {
  return `timeline:${kind}:${authority}:${encodeURIComponent(externalID)}`;
}

export function issueEventKind(type: string): WorkTimelineNodeKind {
  if (type === "issue.created" || type === "issue.status_changed") return "work_event";
  if (EVIDENCE_ISSUE_EVENT_TYPES.has(type)) return "evidence";
  return "issue_event";
}

export function issueEventName(type: string): string {
  if (type === "issue.created") return "work.created.v1";
  if (type === "issue.status_changed") return "work.status_changed.v1";
  if (EVIDENCE_ISSUE_EVENT_TYPES.has(type)) return "evidence.recorded.v1";
  return type;
}

export function domainRunStatus(status: string): string {
  if (["done", "succeeded", "success"].includes(status)) return "succeeded";
  if (["cancelled", "canceled", "todo", "triage"].includes(status)) return "cancelled";
  if (["failed", "error"].includes(status)) return "failed";
  return status || "succeeded";
}

export function compareTimelineNodes(left: WorkTimelineNode, right: WorkTimelineNode): number {
  return right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id);
}

export function isOlderThanCursor(node: WorkTimelineNode, cursor: CursorPosition): boolean {
  return node.occurred_at < cursor.at || (node.occurred_at === cursor.at && node.id < cursor.id);
}

export function dedupeNodes(nodes: WorkTimelineNode[]): WorkTimelineNode[] {
  return dedupe(nodes, (node) => node.dedupe_key);
}

export function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

export function pageSummary(
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

export function timelineLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) {
    throw new Error(`Work timeline limit must be between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

export function canonicalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Work timeline source timestamp is invalid");
  return new Date(time).toISOString();
}

export function redactedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return jsonObject(redactAuditJsonText(JSON.stringify(payload)));
}

export function jsonObject(value: unknown): Record<string, unknown> {
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

export function cleanText(value: unknown): string {
  return redactAuditText(typeof value === "string" ? value.trim() : "");
}
