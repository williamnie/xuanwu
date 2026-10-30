import { type RunAttemptView, type RunDetail } from "../../db/repositories/runs.ts";
import { type RunID, type RunTransitionAudit, type WorkID } from "../../domain/run/contracts.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { cleanString } from "../../util/values.ts";
import { publicRun, requireRun, runError, positiveIntegerParam, RUN_HTTP_POLICY_REF, RunHttpError } from "./runApi.listResponse.ts";
import type { RunTranscriptRow, RunAction } from "./runApi.model.ts";

export function detailResponse(context: ReadApiContext, request: Request): Record<string, unknown> {
  return {
    run: publicRun(requireRun(context, runID(request), context.readDatabase ?? context.database))
  };
}

export function transcriptResponse(context: ReadApiContext, request: Request): Record<string, unknown> {
  const database = context.readDatabase ?? context.database;
  const run = requireRun(context, runID(request), database);
  const params = new URL(request.url).searchParams;
  const requestedAttemptID = cleanString(params.get("attempt_id"));
  const attempt = requestedAttemptID
    ? run.attempts.find((candidate) => candidate.id === requestedAttemptID)
    : run.attempts.at(-1);
  if (!attempt) throw runError(400, "invalid_request", "attempt_id does not belong to this Run");
  const beforeID = optionalPositiveInteger(params.get("before_id"), "before_id");
  const limit = positiveIntegerParam(params.get("limit"), "limit", 100, 200);
  const clauses = [
    "issue_id=?",
    "type='issue.log'",
    "json_valid(payload)",
    "json_extract(payload, '$.raw_method')='item/completed'",
    "json_extract(payload, '$.payload.item_type')='agentMessage'",
    "length(trim(coalesce(json_extract(payload, '$.text'), ''))) > 0",
    "json_extract(payload, '$.runtime_evidence_correlation.run_id')=?",
    "json_extract(payload, '$.runtime_evidence_correlation.attempt_id')=?"
  ];
  const args: Array<number | string> = [issueIDFromWorkID(run.work_id), run.id, attempt.id];
  if (beforeID !== undefined) {
    clauses.push("id < ?");
    args.push(beforeID);
  }
  args.push(limit + 1);
  const rows = database.sqlite.query<RunTranscriptRow, Array<number | string>>(`
    select id, payload, created_at from issue_events indexed by idx_issue_events_issue_type
    where ${clauses.join(" and ")} order by id desc limit ?
  `).all(...args);
  const page = rows.slice(0, limit);
  return {
    data: page.reverse().map((row) => transcriptMessage(row, attempt.provider_ref.turn_ref)),
    nextCursor: rows.length > limit ? String(page[0]?.id ?? "") : ""
  };
}

export function transcriptMessage(row: RunTranscriptRow, fallbackTurnID: string): Record<string, unknown> {
  const body = safeJSONRecord(row.payload);
  const snapshot = safeRecord(body.payload);
  const correlation = safeRecord(body.runtime_evidence_correlation);
  return {
    created_at: row.created_at,
    id: cleanString(snapshot.item_id) || `issue-event:${row.id}`,
    phase: cleanString(snapshot.phase) || "commentary",
    provider_turn_id: cleanString(correlation.provider_turn_id) || fallbackTurnID,
    source_event_id: row.id,
    text: cleanString(body.text),
    type: "agentMessage"
  };
}

export function latestAttempt(run: RunDetail): RunAttemptView {
  const attempt = run.attempts.at(-1);
  if (!attempt) throw runError(409, "run_attempt_missing", "Run has no Attempt");
  return attempt;
}

export function runID(request: Request): RunID {
  const raw = pathValue(request, "runs");
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw).trim();
  } catch {
    throw runError(400, "invalid_run_id", "Run id is invalid");
  }
  if (!/^xw:run:issue_runs:.+$/.test(decoded)) {
    throw runError(400, "invalid_run_id", "Run id is invalid");
  }
  return decoded as RunID;
}

export function issueIDFromWorkID(value: WorkID): number {
  const id = Number(value.slice("xw:work:issues:".length));
  if (!Number.isSafeInteger(id) || id <= 0) throw runError(500, "run_mapping_error", "Run Work mapping is invalid");
  return id;
}

export function actionInput(request: Request): RunAction {
  let action = "";
  try {
    action = decodeURIComponent(pathValue(request, "actions")).trim();
  } catch {
    throw runError(400, "invalid_action", "Run action is invalid");
  }
  if (action !== "interrupt" && action !== "resume" && action !== "retry") {
    throw runError(400, "invalid_action", "Run action must be interrupt, resume, or retry");
  }
  return action;
}

export function pathValue(request: Request, preceding: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts[parts.indexOf(preceding) + 1] ?? "";
}

export function auditInput(value: unknown): RunTransitionAudit {
  const audit = objectValue(value, "audit");
  assertKeys(audit, ["actor", "correlation_id", "event_id", "occurred_at", "reason"]);
  const actor = objectValue(audit.actor, "audit.actor");
  assertKeys(actor, ["id", "kind"]);
  const kind = requiredString(actor.kind, "audit.actor.kind");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) {
    throw runError(400, "invalid_request", "audit.actor.kind is invalid");
  }
  const occurredAt = requiredString(audit.occurred_at, "audit.occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw runError(400, "invalid_request", "audit.occurred_at must be a timestamp");
  }
  return {
    actor: { id: requiredString(actor.id, "audit.actor.id"), kind: kind as RunTransitionAudit["actor"]["kind"] },
    correlation_id: requiredString(audit.correlation_id, "audit.correlation_id"),
    event_id: requiredString(audit.event_id, "audit.event_id"),
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: RUN_HTTP_POLICY_REF },
    occurred_at: occurredAt,
    reason: requiredString(audit.reason, "audit.reason")
  };
}

export function optionalPositiveInteger(value: string | null, field: string): number | undefined {
  const raw = cleanString(value);
  if (raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw runError(400, "invalid_request", `${field} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw runError(400, "invalid_request", `${field} must be a positive integer`);
  return parsed;
}

export function revisionInput(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw runError(400, "invalid_request", `${field} must be a non-negative integer`);
  }
  return value;
}

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw runError(400, "invalid_request", "Request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RunHttpError) throw error;
    throw runError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string): string {
  const text = cleanString(value);
  if (text === "") throw runError(400, "invalid_request", `${field} is required`);
  return text;
}

export function safeJSONRecord(value: string): Record<string, unknown> {
  try {
    return safeRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw runError(400, "invalid_request", `Unsupported fields: ${unknown.sort().join(", ")}`);
  }
}
