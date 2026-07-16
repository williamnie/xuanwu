import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getStoredHandoff, listStoredHandoffs, type StoredHandoffRecord } from "../db/repositories/handoffs.ts";
import {
  DELIVERY_MODES,
  HANDOFF_STATUSES,
  type HandoffDeliveryAction,
  type HandoffRecord
} from "../domain/handoff/contracts.ts";
import { buildHandoffNotificationSummary } from "../notifications/handoffNotifier.ts";
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUMMARY_LIMIT = 320;

export const HANDOFF_HTTP_COMPATIBILITY_POLICY = {
  dual_read: "none-in-W0; W1-shadow-comparison-only-after-G2",
  dual_write: "none; producers-append-one-idempotent-Handoff-stream-record",
  fact_authority: "Git-Evidence-review-provider-and-audit-carriers",
  final_removal_gate: "P11.03/P11.06-and-G7-and-zero-legacy-consumer-for-one-release-and-restore-rehearsal",
  read_authority: "issue_events:handoff.*.v1",
  refresh_semantics: "fresh-local-read-of-Handoff-stream-and-delivery-outbox; no-external-write",
  rollback: "unregister-Handoff-routes-and-stop-producer-recording-without-deleting-events-or-notifications",
  write_authority: "domain-Handoff-producers-through-append-only-repository"
} as const;

type DeliveryActionStatus = {
  action: HandoffDeliveryAction["action"];
  current_status: "failed" | "pending" | "queued" | "retry" | "sending" | "succeeded";
  source_ref: string;
  updated_at: string;
};

type DeliveryStatus = {
  actions: DeliveryActionStatus[];
  overall: "delivered" | "delivering" | "draft" | "failed" | "ready" | "superseded";
  refreshed_at: string;
};

export function registerHandoffRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/handoffs", (request) => handoffResponse(() => listResponse(context.database, request)));
  router.get("/api/handoffs/:id", (request) => handoffResponse(() => detailResponse(context.database, request)));
}

function listResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const filter = parsedFilter(db, request);
  const page = listStoredHandoffs(db, filter);
  return {
    compatibility: HANDOFF_HTTP_COMPATIBILITY_POLICY,
    filters: {
      delivery_mode: filter.delivery_modes ?? [],
      project_id: filter.project_id ?? "",
      status: filter.statuses ?? [],
      work_id: filter.work_id ?? ""
    },
    has_more: page.has_more,
    items: page.items.map((record) => handoffSummary(db, record)),
    limit: filter.limit,
    next_cursor: page.next_before_event_id ? encodeCursor(page.next_before_event_id) : "",
    skipped_invalid: page.skipped_invalid
  };
}

function detailResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const record = getStoredHandoff(db, handoffID(request));
  if (!record) throw handoffError(404, "handoff_not_found", "Handoff not found");
  return {
    compatibility: HANDOFF_HTTP_COMPATIBILITY_POLICY,
    delivery_status: deliveryStatus(db, record.handoff),
    handoff: record.handoff,
    issue_id: record.issue_id,
    notification_summary: buildHandoffNotificationSummary(record.handoff),
    project_id: record.project_id,
    storage: {
      event_id: record.event_id,
      event_type: record.event_type,
      recorded_at: record.recorded_at,
      source: record.source
    }
  };
}

function handoffSummary(db: RunnerDatabase, record: StoredHandoffRecord): Record<string, unknown> {
  const notification = buildHandoffNotificationSummary(record.handoff);
  return {
    changed_file_count: record.handoff.changed_files.length,
    delivery: {
      branch_ref: notification.branch_ref,
      commit_ref: notification.commit_ref,
      external_url: notification.external_url,
      mode: record.handoff.delivery.mode,
      pull_request_ref: notification.pull_request_ref
    },
    delivery_status: deliveryStatus(db, record.handoff),
    evidence_count: record.handoff.evidence_ids.length,
    id: record.handoff.id,
    issue_id: record.issue_id,
    next_step: notification.next_step,
    notification_summary: notification.summary,
    project_id: record.project_id,
    risk_count: record.handoff.risks.length,
    status: record.handoff.status,
    summary: boundedText(record.handoff.summary, SUMMARY_LIMIT),
    updated_at: record.handoff.updated_at,
    work_id: record.handoff.work_id
  };
}

function deliveryStatus(db: RunnerDatabase, handoff: HandoffRecord): DeliveryStatus {
  const tracker = latestTrackerStatus(db, handoff.id);
  const actions = handoff.delivery_actions.map((action): DeliveryActionStatus => {
    if (action.action === "tracker_update" && tracker) {
      return {
        action: action.action,
        current_status: tracker.status,
        source_ref: `sync_outbox:${tracker.id}`,
        updated_at: tracker.updated_at
      };
    }
    return {
      action: action.action,
      current_status: action.outcome === "not_executed" ? "pending" : action.outcome,
      source_ref: action.audit_event_ref,
      updated_at: handoff.updated_at
    };
  });
  return {
    actions,
    overall: overallDeliveryStatus(handoff, actions),
    refreshed_at: new Date().toISOString()
  };
}

function overallDeliveryStatus(
  handoff: HandoffRecord,
  actions: DeliveryActionStatus[]
): DeliveryStatus["overall"] {
  if (handoff.status === "superseded") return "superseded";
  if (handoff.status === "delivered") return "delivered";
  if (actions.some((action) => action.current_status === "failed")) return "failed";
  if (actions.some((action) => ["queued", "retry", "sending"].includes(action.current_status))) return "delivering";
  return handoff.status === "ready" ? "ready" : "draft";
}

function latestTrackerStatus(db: RunnerDatabase, handoffIDValue: string): {
  id: number;
  status: "failed" | "queued" | "retry" | "sending" | "succeeded";
  updated_at: string;
} | null {
  const row = db.sqlite.query<{ id: number; status: string; updated_at: string }, [string]>(`
    select id, status, updated_at from sync_outbox
    where operation_kind='tracker_update' and handoff_id=?
    order by updated_at desc, id desc limit 1
  `).get(handoffIDValue);
  if (!row || !["failed", "queued", "retry", "sending", "sent"].includes(row.status)) return null;
  return {
    id: row.id,
    status: row.status === "sent" ? "succeeded" : row.status as "failed" | "queued" | "retry" | "sending",
    updated_at: row.updated_at
  };
}

function parsedFilter(db: RunnerDatabase, request: Request): {
  before_event_id?: number;
  delivery_modes?: string[];
  limit: number;
  project_id?: string;
  statuses?: string[];
  work_id?: string;
} {
  const params = new URL(request.url).searchParams;
  const projectID = optionalText(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw handoffError(404, "project_not_found", "Project not found");
  const workID = optionalText(params.get("work_id"));
  if (workID) {
    const issueID = issueIDFromWorkID(workID);
    if (!issueID) throw handoffError(400, "invalid_work_id", "Work id is invalid");
    if (!getIssue(db, issueID)) throw handoffError(404, "work_not_found", "Work not found");
  }
  const statuses = stringParams(params, "status");
  if (statuses.some((status) => !HANDOFF_STATUSES.includes(status as typeof HANDOFF_STATUSES[number]))) {
    throw handoffError(400, "invalid_status", "Handoff status is invalid");
  }
  const deliveryModes = stringParams(params, "delivery_mode");
  if (deliveryModes.some((mode) => !DELIVERY_MODES.includes(mode as typeof DELIVERY_MODES[number]))) {
    throw handoffError(400, "invalid_delivery_mode", "Handoff delivery_mode is invalid");
  }
  const cursor = optionalText(params.get("cursor"));
  return {
    ...(cursor ? { before_event_id: decodeCursor(cursor) } : {}),
    ...(deliveryModes.length > 0 ? { delivery_modes: deliveryModes } : {}),
    limit: boundedLimit(params.get("limit")),
    ...(projectID ? { project_id: projectID } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(workID ? { work_id: workID } : {})
  };
}

function handoffID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("handoffs") + 1] ?? "";
  try {
    const decoded = decodeURIComponent(raw).trim();
    if (!/^xw:handoff:derived:[A-Za-z0-9._~%-]+$/.test(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw handoffError(400, "invalid_handoff_id", "Handoff id is invalid");
  }
}

function issueIDFromWorkID(value: string): number | null {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function stringParams(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
}

function boundedLimit(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw handoffError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(eventID: number): string {
  return Buffer.from(`handoff:${eventID}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^handoff:([1-9][0-9]*)$/.exec(decoded);
    if (!match) throw new Error("invalid");
    return Number(match[1]);
  } catch {
    throw handoffError(400, "invalid_cursor", "Handoff cursor is invalid");
  }
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function optionalText(value: string | null): string {
  return value?.trim() ?? "";
}

class HandoffHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function handoffError(status: number, code: string, message: string): HandoffHttpError {
  return new HandoffHttpError(status, code, message);
}

async function handoffResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const value = await read();
    return value instanceof Response ? value : json(value);
  } catch (error) {
    if (error instanceof HandoffHttpError) return json({ code: error.code, message: error.message }, { status: error.status });
    throw error;
  }
}
