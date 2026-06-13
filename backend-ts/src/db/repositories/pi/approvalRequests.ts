import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  getByID,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiApprovalRequest = {
  approval_id: string;
  approval_source: string;
  created_at: string;
  decision: string;
  delivered_at: string;
  delivery_channel: string;
  delivery_state: string;
  issue_id: number;
  project_id: string;
  provider: string;
  provider_approval_id: string;
  raw_payload_json: string;
  request_summary: string;
  run_id: string;
  request_type: string;
  resolved_at: string;
  resolved_decision: string;
  resolved_scope: string;
  risk: string;
  session_id: string;
  status: string;
  summary: string;
  thread_id: string;
  turn_id: string;
  updated_at: string;
};

export type PiApprovalRequestInput = PatchInput<PiApprovalRequest>;
export type PiApprovalRequestFilter = {
  issueId?: number;
  projectId?: string;
  provider?: string;
  runId?: string;
  sessionId?: string;
  status?: string;
  threadId?: string;
};
type ApprovalPatchValue = string | number;

const TABLE = "pi_approval_requests";
const COLUMNS = `approval_id, project_id, issue_id, run_id, provider, session_id, thread_id, turn_id,
  request_type, summary, request_summary, risk, status, decision, approval_source, provider_approval_id,
  delivery_state, delivery_channel, delivered_at, resolved_decision, resolved_scope, resolved_at,
  raw_payload_json, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "project_id", "issue_id", "run_id", "provider", "session_id", "thread_id", "turn_id", "request_type",
  "summary", "request_summary", "risk", "status", "decision", "approval_source", "provider_approval_id",
  "delivery_state", "delivery_channel", "delivered_at", "resolved_decision", "resolved_scope",
  "resolved_at", "raw_payload_json"
] as const;

export function createPiApprovalRequest(
  db: RunnerDatabase,
  input: PiApprovalRequestInput
): PiApprovalRequest {
  return upsertPiApprovalRequest(db, input);
}

export function upsertPiApprovalRequest(
  db: RunnerDatabase,
  input: PiApprovalRequestInput
): PiApprovalRequest {
  const record = normalizeCreate(input);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(25)})
    on conflict(approval_id) do update set
      project_id=coalesce(nullif(excluded.project_id, ''), ${TABLE}.project_id),
      issue_id=case when excluded.issue_id > 0 then excluded.issue_id else ${TABLE}.issue_id end,
      run_id=coalesce(nullif(excluded.run_id, ''), ${TABLE}.run_id),
      provider=coalesce(nullif(excluded.provider, ''), ${TABLE}.provider),
      session_id=coalesce(nullif(excluded.session_id, ''), ${TABLE}.session_id),
      thread_id=coalesce(nullif(excluded.thread_id, ''), ${TABLE}.thread_id),
      turn_id=coalesce(nullif(excluded.turn_id, ''), ${TABLE}.turn_id),
      request_type=coalesce(nullif(excluded.request_type, ''), ${TABLE}.request_type),
      summary=coalesce(nullif(excluded.summary, ''), ${TABLE}.summary),
      request_summary=coalesce(nullif(excluded.request_summary, ''), ${TABLE}.request_summary),
      risk=coalesce(nullif(excluded.risk, ''), ${TABLE}.risk),
      status=case when ${TABLE}.status='pending'
        then coalesce(nullif(excluded.status, ''), ${TABLE}.status)
        else ${TABLE}.status end,
      decision=coalesce(nullif(excluded.decision, ''), ${TABLE}.decision),
      approval_source=coalesce(nullif(excluded.approval_source, ''), ${TABLE}.approval_source),
      provider_approval_id=coalesce(nullif(excluded.provider_approval_id, ''), ${TABLE}.provider_approval_id),
      delivery_state=case
        when excluded.delivery_state <> 'pending' then excluded.delivery_state
        when ${TABLE}.delivery_state <> '' then ${TABLE}.delivery_state
        else excluded.delivery_state end,
      delivery_channel=coalesce(nullif(excluded.delivery_channel, ''), ${TABLE}.delivery_channel),
      delivered_at=coalesce(nullif(excluded.delivered_at, ''), ${TABLE}.delivered_at),
      raw_payload_json=case when excluded.raw_payload_json <> '{}' then excluded.raw_payload_json else ${TABLE}.raw_payload_json end,
      updated_at=excluded.updated_at`, [
    record.approval_id, record.project_id, record.issue_id, record.run_id, record.provider,
    record.session_id, record.thread_id, record.turn_id, record.request_type, record.summary,
    record.request_summary, record.risk, record.status, record.decision, record.approval_source,
    record.provider_approval_id, record.delivery_state, record.delivery_channel, record.delivered_at,
    record.resolved_decision, record.resolved_scope, record.resolved_at, record.raw_payload_json,
    timestamp, timestamp
  ]);
  return mustGetPiApprovalRequest(db, record.approval_id);
}

export function getPiApprovalRequest(db: RunnerDatabase, id: string): PiApprovalRequest | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiApprovalRequest, "approval_id");
}

export function listPiApprovalRequests(
  db: RunnerDatabase,
  filter: PiApprovalRequestFilter = {}
): PiApprovalRequest[] {
  return listRows(db, TABLE, COLUMNS, mapPiApprovalRequest, buildFilter([
    ["project_id=?", filter.projectId],
    ["issue_id=?", filter.issueId],
    ["provider=?", filter.provider],
    ["run_id=?", filter.runId],
    ["session_id=?", filter.sessionId],
    ["thread_id=?", filter.threadId],
    ["status=?", filter.status]
  ], "created_at asc, approval_id asc"));
}

export function markPiApprovalDelivered(
  db: RunnerDatabase,
  id: string,
  input: { channel: string; timestamp?: Date }
): PiApprovalRequest {
  const current = mustGetPiApprovalRequest(db, id);
  if (current.status !== "pending") return current;
  return updatePiApprovalRequest(db, id, {
    delivered_at: (input.timestamp ?? new Date()).toISOString(),
    delivery_channel: input.channel,
    delivery_state: "delivered",
    status: "delivered"
  });
}

export function resolvePiApprovalRequestRecord(
  db: RunnerDatabase,
  id: string,
  input: { decision: string; scope?: string; status?: string; timestamp?: Date }
): PiApprovalRequest {
  const current = mustGetPiApprovalRequest(db, id);
  if (isResolved(current.status)) return current;
  const decision = cleanString(input.decision);
  return updatePiApprovalRequest(db, id, {
    decision,
    resolved_at: (input.timestamp ?? new Date()).toISOString(),
    resolved_decision: decision,
    resolved_scope: cleanString(input.scope),
    status: cleanString(input.status) || statusForDecision(decision)
  });
}

export function updatePiApprovalRequest(
  db: RunnerDatabase,
  id: string,
  input: PiApprovalRequestInput
): PiApprovalRequest {
  const patch = normalizePatch(input);
  const columns = UPDATE_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return mustGetPiApprovalRequest(db, id);
  db.sqlite.run(`update ${TABLE} set ${columns
    .map((column) => `${column}=?`).join(", ")}, updated_at=? where approval_id=?`, [
    ...columns.map((column) => patch[column] as ApprovalPatchValue),
    now(),
    id
  ]);
  return mustGetPiApprovalRequest(db, id);
}

function normalizeCreate(input: PiApprovalRequestInput): PiApprovalRequest {
  const approvalID = cleanString(input.approval_id);
  if (approvalID === "") throw new Error("approval_id is required");
  return {
    approval_id: approvalID,
    approval_source: cleanString(input.approval_source),
    created_at: "",
    decision: cleanString(input.decision),
    delivered_at: cleanString(input.delivered_at),
    delivery_channel: cleanString(input.delivery_channel),
    delivery_state: cleanString(input.delivery_state) || "pending",
    issue_id: integerInput(input.issue_id),
    project_id: cleanString(input.project_id),
    provider: cleanString(input.provider),
    provider_approval_id: cleanString(input.provider_approval_id) || approvalID,
    raw_payload_json: payloadText(input.raw_payload_json),
    request_summary: approvalSummary(input),
    request_type: cleanString(input.request_type),
    resolved_at: cleanString(input.resolved_at),
    resolved_decision: cleanString(input.resolved_decision),
    resolved_scope: cleanString(input.resolved_scope),
    risk: cleanString(input.risk) || "medium",
    run_id: cleanString(input.run_id),
    session_id: sessionID(input),
    status: cleanString(input.status) || "pending",
    summary: approvalSummary(input),
    thread_id: cleanString(input.thread_id) || sessionID(input),
    turn_id: cleanString(input.turn_id),
    updated_at: ""
  };
}

function normalizePatch(input: PiApprovalRequestInput): PiApprovalRequestInput {
  return {
    ...input,
    summary: input.summary === undefined ? undefined : redactAuditText(cleanString(input.summary)),
    raw_payload_json: input.raw_payload_json === undefined ? undefined : payloadText(input.raw_payload_json),
    request_summary: input.request_summary === undefined ? undefined : redactAuditText(cleanString(input.request_summary))
  };
}

function mapPiApprovalRequest(row: Record<string, unknown>): PiApprovalRequest {
  return {
    approval_id: requiredString(row.approval_id, "pi_approval_requests.approval_id"),
    approval_source: optionalString(row.approval_source),
    created_at: requiredString(row.created_at, "pi_approval_requests.created_at"),
    decision: optionalString(row.decision),
    delivered_at: optionalString(row.delivered_at),
    delivery_channel: optionalString(row.delivery_channel),
    delivery_state: optionalString(row.delivery_state),
    issue_id: integerValue(row.issue_id, "pi_approval_requests.issue_id"),
    project_id: optionalString(row.project_id),
    provider: optionalString(row.provider),
    provider_approval_id: optionalString(row.provider_approval_id),
    raw_payload_json: redactAuditJsonText(optionalString(row.raw_payload_json) || "{}"),
    request_summary: redactAuditText(optionalString(row.request_summary)),
    request_type: optionalString(row.request_type),
    resolved_at: optionalString(row.resolved_at),
    resolved_decision: optionalString(row.resolved_decision),
    resolved_scope: optionalString(row.resolved_scope),
    risk: optionalString(row.risk),
    run_id: optionalString(row.run_id),
    session_id: optionalString(row.session_id),
    status: requiredString(row.status, "pi_approval_requests.status"),
    summary: redactAuditText(optionalString(row.summary)),
    thread_id: optionalString(row.thread_id),
    turn_id: optionalString(row.turn_id),
    updated_at: requiredString(row.updated_at, "pi_approval_requests.updated_at")
  };
}

function approvalSummary(input: PiApprovalRequestInput): string {
  const summary = cleanString(input.summary) || cleanString(input.request_summary);
  return redactAuditText(summary);
}

function sessionID(input: PiApprovalRequestInput): string {
  return cleanString(input.session_id) || cleanString(input.thread_id);
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return redactAuditJsonText(jsonText(value, "{}"));
  return redactAuditJsonText(JSON.stringify(value ?? {}));
}

function isResolved(status: string): boolean {
  return ["approved", "rejected", "cancelled"].includes(status);
}

function statusForDecision(decision: string): string {
  return isApprovalDecision(decision) ? "approved" : "rejected";
}

function isApprovalDecision(decision: string): boolean {
  return ["approve", "approved", "accept", "approve_session", "approved_for_session", "acceptForSession"]
    .includes(decision);
}

function mustGetPiApprovalRequest(db: RunnerDatabase, id: string): PiApprovalRequest {
  const request = getPiApprovalRequest(db, id);
  if (!request) throw new Error("PI approval request missing after write");
  return request;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
