import type { RunnerDatabase } from "../db/database.ts";
import { getStoredEvidence } from "../db/repositories/evidence.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getRun } from "../db/repositories/runs.ts";
import {
  getStoredHandoff,
  listStoredHandoffs,
  recordHandoff,
  type StoredHandoffRecord
} from "../db/repositories/handoffs.ts";
import {
  DELIVERY_MODES,
  HANDOFF_STATUSES,
  type HandoffLinkContext,
  type HandoffDeliveryAction,
  type HandoffRecord
} from "../domain/handoff/contracts.ts";
import { buildHandoffDiffSummary, type HandoffDiffSummary } from "../domain/handoff/diffSummary.ts";
import {
  createReviewerLoopService,
  type ReviewerDecisionAction,
  type ReviewerFinding,
  type ReviewerLoopAuditEvent
} from "../domain/handoff/reviewerLoop.ts";
import { buildHandoffNotificationSummary } from "../notifications/handoffNotifier.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUMMARY_LIMIT = 320;
const REVIEW_COMMENT_LIMIT = 4096;
const REVIEW_HTTP_ACTOR_REF = "user:local-operator";
const REVIEW_HTTP_POLICY_REF = "xuanwu-handoff-human-review-http-v1";
const REVIEW_HTTP_PROVIDER_ID = "human-review-http";
const REVIEW_HTTP_OUTCOME_EVENT = "handoff.review.http_completed.v1";

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

type ReviewAction = Extract<ReviewerDecisionAction, "accept" | "request_changes">;

type ReviewAudit = {
  actor: { id: string; kind: "user" };
  correlation_id: string;
  event_id: string;
  occurred_at: string;
  reason: string;
};

type ReviewOutcome = {
  action: ReviewAction;
  actor_ref: string;
  audit_event_id: string;
  comment: string;
  handoff_id: string;
  occurred_at: string;
  previous_revision: number;
  resulting_revision: number;
  status: "accepted" | "changes_requested";
};

type ReviewSummary = {
  available_actions: ReviewAction[];
  decided_at: string;
  history: ReviewOutcome[];
  next_step: string;
  reviewer_ref: string;
  state: HandoffRecord["review"]["state"];
};

export function registerHandoffRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/handoffs", (request) => handoffResponse(() => listResponse(context.database, request)));
  router.get("/api/handoffs/:id", (request) => handoffResponse(() => detailResponse(context.database, request)));
  router.post("/api/handoffs/:id/reviews", (request) => handoffResponse(() => reviewResponse(context.database, request)));
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
  return detailRecord(db, record);
}

function detailRecord(db: RunnerDatabase, record: StoredHandoffRecord): Record<string, unknown> {
  return {
    compatibility: HANDOFF_HTTP_COMPATIBILITY_POLICY,
    delivery_status: deliveryStatus(db, record.handoff),
    diff_summary: diffSummary(db, record.handoff),
    handoff: record.handoff,
    issue_id: record.issue_id,
    notification_summary: buildHandoffNotificationSummary(record.handoff),
    project_id: record.project_id,
    review_summary: reviewSummary(db, record),
    storage: {
      event_id: record.event_id,
      event_type: record.event_type,
      recorded_at: record.recorded_at,
      source: record.source
    }
  };
}

async function reviewResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const record = getStoredHandoff(db, handoffID(request));
  if (!record) throw handoffError(404, "handoff_not_found", "Handoff not found");
  const body = await objectBody(request);
  assertKeys(body, ["action", "audit", "comment", "expected_revision"]);
  const action = reviewAction(body.action);
  const audit = reviewAudit(body.audit);
  const comment = reviewComment(body.comment, action);
  const replay = replayedReview(db, record, audit.event_id, action);
  if (replay) return reviewMutationResponse(db, record.handoff.id, replay, true);
  const expectedRevision = revision(body.expected_revision);
  if (expectedRevision !== record.handoff.revision) {
    throw handoffError(409, "stale_handoff_revision", "Handoff revision is stale; refresh before reviewing");
  }
  const summary = reviewSummary(db, record);
  if (!summary.available_actions.includes(action)) {
    throw handoffError(409, "review_action_unavailable", `Handoff review action ${action} is not available`);
  }
  if (record.handoff.review.reviewer_refs.length > 0 &&
    !record.handoff.review.reviewer_refs.includes(audit.actor.id)) {
    throw handoffError(403, "reviewer_not_assigned", "Authenticated review actor is not assigned to this Handoff");
  }

  const context = handoffLinkContext(db, record.handoff);
  const finding = reviewFinding(record.handoff, action, comment);
  const service = createReviewerLoopService({
    audit_sink: {
      record(event: ReviewerLoopAuditEvent) {
        recordIssueEvent(db, record.issue_id, event.event_type, event);
      }
    },
    decision_gate: {
      authorize: () => ({
        allowed: true,
        authority: "human_approval",
        authorization_ref: `${audit.event_id}:authorization`,
        policy_ref: REVIEW_HTTP_POLICY_REF,
        reason: "Authenticated Handoff review action"
      })
    },
    now: () => audit.occurred_at,
    providers: [{
      descriptor: { mode: "human", provider_id: REVIEW_HTTP_PROVIDER_ID },
      review: async () => ({
        action,
        decision_ref: `${audit.event_id}:decision`,
        findings: [finding],
        reviewer_ref: audit.actor.id,
        source: "human"
      })
    }],
    repair_run_scheduler: {
      schedule: async () => {
        throw new Error("repair Run scheduling is outside the synchronous Handoff review HTTP action");
      }
    }
  });

  let result;
  try {
    // This authenticated endpoint records exactly one human decision. A changes request
    // stops at the Reviewer Loop budget boundary; a later Repair Workflow must create
    // the fresh Run/Evidence and superseding Handoff instead of this HTTP handler faking it.
    result = await service.execute({
      audit: {
        actor: audit.actor,
        correlation_id: audit.correlation_id
      },
      handoff: record.handoff,
      handoff_context: context,
      max_cycles: 1,
      mode: "human",
      provider_id: REVIEW_HTTP_PROVIDER_ID,
      request_id: audit.event_id
    });
  } catch {
    throw handoffError(409, "review_rejected", "Handoff review action was rejected by the review gate");
  }
  if ((action === "accept" && result.status !== "accepted") ||
    (action === "request_changes" && result.status !== "budget_exhausted")) {
    throw handoffError(409, "review_rejected", "Handoff review action did not reach the expected terminal state");
  }

  const current = getStoredHandoff(db, record.handoff.id);
  if (!current || current.handoff.revision !== expectedRevision ||
    !reviewSummary(db, current).available_actions.includes(action)) {
    throw handoffError(409, "review_action_conflict", "Handoff review state changed; refresh before reviewing");
  }
  const reviewed = action === "accept" ? result.handoff : record.handoff;
  if (action === "accept") {
    recordHandoff(db, record.issue_id, reviewed, {
      recorded_at: audit.occurred_at,
      source: "handoff-review-http"
    });
  }
  const outcome: ReviewOutcome = {
    action,
    actor_ref: audit.actor.id,
    audit_event_id: audit.event_id,
    comment,
    handoff_id: record.handoff.id,
    occurred_at: audit.occurred_at,
    previous_revision: record.handoff.revision,
    resulting_revision: reviewed.revision,
    status: action === "accept" ? "accepted" : "changes_requested"
  };
  recordIssueEvent(db, record.issue_id, REVIEW_HTTP_OUTCOME_EVENT, outcome);
  return reviewMutationResponse(db, record.handoff.id, outcome, false);
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

function diffSummary(db: RunnerDatabase, handoff: HandoffRecord):
  | (HandoffDiffSummary & { availability: "available" })
  | { availability: "unavailable"; source_evidence_id: string }
  | null {
  for (const evidenceID of [...handoff.evidence_ids].reverse()) {
    const stored = getStoredEvidence(db, evidenceID);
    if (!stored || stored.evidence.kind !== "git") continue;
    try {
      return { ...buildHandoffDiffSummary({ git_evidence: stored.evidence }), availability: "available" };
    } catch {
      return { availability: "unavailable", source_evidence_id: evidenceID };
    }
  }
  return null;
}

function reviewSummary(db: RunnerDatabase, record: StoredHandoffRecord): ReviewSummary {
  const rows = db.sqlite.query<{ payload: string }, [number, string, string]>(`
    select payload from issue_events
    where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload, '$.handoff_id')=?
    order by id desc limit 20
  `).all(record.issue_id, REVIEW_HTTP_OUTCOME_EVENT, record.handoff.id);
  const history = rows.flatMap((row) => {
    const outcome = parsedReviewOutcome(row.payload);
    return outcome ? [outcome] : [];
  });
  const latest = history[0];
  const state = latest?.status === "changes_requested"
    ? "changes_requested"
    : latest?.status === "accepted"
      ? "approved"
      : record.handoff.review.state;
  const availableActions: ReviewAction[] = record.handoff.status === "ready" && state === "pending"
    ? ["accept", "request_changes"]
    : [];
  return {
    available_actions: availableActions,
    decided_at: latest?.occurred_at ?? record.handoff.review.decided_at ?? "",
    history,
    next_step: state === "changes_requested"
      ? "Create a repair Run and superseding Handoff before re-review"
      : state === "approved"
        ? "Continue the gated delivery actions"
        : state === "pending" ? "Complete the required Handoff review" : "",
    reviewer_ref: latest?.actor_ref ?? record.handoff.review.reviewer_refs.at(-1) ?? "",
    state
  };
}

function parsedReviewOutcome(payload: string): ReviewOutcome | null {
  try {
    const value = JSON.parse(payload) as Partial<ReviewOutcome>;
    if (value.action !== "accept" && value.action !== "request_changes") return null;
    if (value.status !== "accepted" && value.status !== "changes_requested") return null;
    const occurredAt = canonicalTimestamp(value.occurred_at, "review occurred_at");
    const previousRevision = revision(value.previous_revision);
    const resultingRevision = revision(value.resulting_revision);
    return {
      action: value.action,
      actor_ref: requiredText(value.actor_ref, "review actor_ref", 512),
      audit_event_id: requiredText(value.audit_event_id, "review audit_event_id", 512),
      comment: optionalText(value.comment).slice(0, REVIEW_COMMENT_LIMIT),
      handoff_id: requiredText(value.handoff_id, "review handoff_id", 512),
      occurred_at: occurredAt,
      previous_revision: previousRevision,
      resulting_revision: resultingRevision,
      status: value.status
    };
  } catch {
    return null;
  }
}

function replayedReview(
  db: RunnerDatabase,
  record: StoredHandoffRecord,
  auditEventID: string,
  action: ReviewAction
): ReviewOutcome | null {
  const row = db.sqlite.query<{ payload: string }, [number, string, string]>(`
    select payload from issue_events
    where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload, '$.audit_event_id')=?
    order by id desc limit 1
  `).get(record.issue_id, REVIEW_HTTP_OUTCOME_EVENT, auditEventID);
  if (!row) return null;
  const outcome = parsedReviewOutcome(row.payload);
  if (!outcome || outcome.handoff_id !== record.handoff.id || outcome.action !== action) {
    throw handoffError(409, "review_event_conflict", "Review audit event id was already used for another action");
  }
  return outcome;
}

function reviewMutationResponse(
  db: RunnerDatabase,
  handoffIDValue: string,
  outcome: ReviewOutcome,
  replayed: boolean
): Record<string, unknown> {
  const latest = getStoredHandoff(db, handoffIDValue);
  if (!latest) throw handoffError(404, "handoff_not_found", "Handoff not found after review");
  return {
    detail: detailRecord(db, latest),
    mutation: {
      action: outcome.action,
      audit_event_id: outcome.audit_event_id,
      replayed,
      status: outcome.status
    }
  };
}

function handoffLinkContext(db: RunnerDatabase, handoff: HandoffRecord): HandoffLinkContext {
  return {
    evidence: handoff.evidence_ids.flatMap((id) => {
      const stored = getStoredEvidence(db, id);
      return stored ? [{ id: stored.evidence.id, status: stored.evidence.status, work_id: stored.evidence.work_id }] : [];
    }),
    runs: handoff.run_ids.flatMap((id) => {
      const run = getRun(db, id);
      return run ? [{ id: run.id, work_id: run.work_id }] : [];
    })
  };
}

function reviewFinding(handoff: HandoffRecord, action: ReviewAction, comment: string): ReviewerFinding {
  return {
    acceptance_criterion_ids: ["handoff-human-review"],
    evidence_ids: [...handoff.evidence_ids],
    finding_id: `human:${action}`,
    kind: "acceptance_criterion",
    result: action === "accept" ? "pass" : "fail",
    summary: comment || "Authenticated reviewer accepted the Handoff"
  };
}

function reviewAction(value: unknown): ReviewAction {
  const action = optionalText(value);
  if (action !== "accept" && action !== "request_changes") {
    throw handoffError(400, "invalid_review_action", "Review action must be accept or request_changes");
  }
  return action;
}

function reviewComment(value: unknown, action: ReviewAction): string {
  const raw = optionalText(value);
  if (raw.length > REVIEW_COMMENT_LIMIT) {
    throw handoffError(400, "invalid_review_comment", `Review comment must not exceed ${REVIEW_COMMENT_LIMIT} characters`);
  }
  const comment = redactedUserVisibleText(raw);
  if (action === "request_changes" && comment === "") {
    throw handoffError(400, "invalid_review_comment", "request_changes requires a review comment");
  }
  return comment;
}

function reviewAudit(value: unknown): ReviewAudit {
  const audit = objectValue(value, "audit");
  assertKeys(audit, ["actor", "correlation_id", "event_id", "occurred_at", "reason"]);
  const actor = objectValue(audit.actor, "audit.actor");
  assertKeys(actor, ["id", "kind"]);
  if (actor.kind !== "user") throw handoffError(400, "invalid_review_audit", "Review audit actor.kind must be user");
  if (actor.id !== REVIEW_HTTP_ACTOR_REF) {
    throw handoffError(403, "review_actor_forbidden", "Review audit actor does not match the authenticated local operator");
  }
  return {
    actor: { id: REVIEW_HTTP_ACTOR_REF, kind: "user" },
    correlation_id: requiredText(audit.correlation_id, "audit.correlation_id", 512),
    event_id: requiredText(audit.event_id, "audit.event_id", 512),
    occurred_at: canonicalTimestamp(audit.occurred_at, "audit.occurred_at"),
    reason: requiredText(audit.reason, "audit.reason", REVIEW_COMMENT_LIMIT)
  };
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw handoffError(400, "invalid_handoff_revision", "expected_revision must be a non-negative integer");
  }
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw handoffError(400, "invalid_request", "Request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HandoffHttpError) throw error;
    throw handoffError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw handoffError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw handoffError(400, "invalid_request", `Unexpected field: ${unexpected.sort()[0]}`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label, 64);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== text) {
    throw handoffError(400, "invalid_review_audit", `${label} must be a canonical ISO timestamp`);
  }
  return text;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = optionalText(value);
  if (text === "") throw handoffError(400, "invalid_request", `${field} is required`);
  if (text.length > maximum) throw handoffError(400, "invalid_request", `${field} exceeds ${maximum} characters`);
  return text;
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

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
