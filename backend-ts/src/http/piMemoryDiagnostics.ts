import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { memoryReflectionEnabled, REFLECTION_LIMITS } from "../pi/memoryReflectionQueue.ts";
import { reflectionReasonCode } from "../pi/memoryReflectionTelemetry.ts";
import { containsSensitiveMemoryContent } from "../pi/memoryPolicy.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { HttpError } from "./errors.ts";

export const MEMORY_DIAGNOSTICS_CONTRACT = "xw.memory-diagnostics.v1";
const MAX_JSON_BYTES = 65_536;
const DAY = 86_400_000;
const EVENT_TYPES = ["issue.memory_reflection_trigger.v1", "issue.memory_reflection_attempt.v1",
  "issue.run_memory_snapshot.v1", "issue.run_memory_injected.v1", "issue.run_memory_cited.v1"];
type ObjectValue = Record<string, unknown>;
type Query = { source: string; projectID: string; issueID: number; runID: string; after: number;
  limit: number; from: string; to: string };
type Row = { cursor: number; id: string | number; issue_id: number; created_at: string;
  type?: string; payload?: string | null; status?: string; reason?: string; run_id?: string;
  memory_id?: string; attempts?: number; updated_at?: string; action_id?: string;
  event_type?: string; action_type?: string; result_json?: string | null; source?: string; decision?: string };

/** 仅投影持久化事实；无模型调用、状态补写、全量日志/转录扫描或当前记忆替换历史版本。 */
export function readMemoryDiagnostics(db: RunnerDatabase, request: Request, projectID: string) {
  const query = parseQuery(db, request, projectID);
  const rows = query.source === "reflections" ? reflectionRows(db, query)
    : query.source === "events" ? eventRows(db, query) : actionRows(db, query);
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  return {
    contract: MEMORY_DIAGNOSTICS_CONTRACT, project_id: projectID, source: query.source,
    range: { from: query.from, to: query.to, issue_id: query.issueID || null, run_id: query.runID || null },
    limit: query.limit, has_more: hasMore, next_after: hasMore ? page.at(-1)!.cursor : null,
    items: page.map(row => query.source === "reflections" ? reflectionView(row)
      : query.source === "events" ? eventView(row) : actionView(row)),
    automatic_reflection: {
      enabled: memoryReflectionEnabled(db, projectID), scope: "current_setting_only",
      disabled_effect: "stops_new_reflections_and_revokes_pending_or_running_writes",
      existing_memory: "preserved_and_still_retrievable", reenable: "future_acceptance_only_no_backfill",
      limits: REFLECTION_LIMITS
    },
    evidence_supported_reuse: { status: "unknown", reason: "no_attribution_evidence_recorded",
      injection_is: "provider_input_prepared", citation_is: "executor_self_report" },
    missing_data: "unknown_not_zero_or_not_triggered", max_json_bytes_per_record: MAX_JSON_BYTES
  };
}

function parseQuery(db: RunnerDatabase, request: Request, projectID: string): Query {
  if (!getProject(db, projectID)) throw new HttpError(404, "project not found");
  const params = new URL(request.url).searchParams;
  const allowed = ["source", "issue_id", "run_id", "after", "limit", "from", "to"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, "unknown or repeated diagnostic parameter");
  }
  const source = params.get("source") ?? "reflections";
  if (!["reflections", "events", "actions"].includes(source)) throw new HttpError(400, "invalid diagnostic source");
  const issueID = integer(params, "issue_id", 0, 1, Number.MAX_SAFE_INTEGER);
  const runID = params.get("run_id") ?? "";
  if (runID.length > 256 || (params.has("run_id") && !runID.trim()) || (runID && !issueID)) {
    throw new HttpError(400, "run_id requires issue_id and a nonempty id of at most 256 characters");
  }
  if (source === "events" && !issueID) throw new HttpError(400, "events require issue_id");
  if (issueID && !db.sqlite.query("select 1 from issues where id=? and project_id=?").get(issueID, projectID)) {
    throw new HttpError(404, "issue not found in project");
  }
  if (runID && !db.sqlite.query("select 1 from issue_runs where id=? and issue_id=?").get(runID, issueID)) {
    throw new HttpError(404, "run not found in issue");
  }
  const to = timestamp(params.get("to"), new Date().toISOString());
  const from = timestamp(params.get("from"), new Date(Date.parse(to) - 7 * DAY).toISOString());
  if (from > to || Date.parse(to) - Date.parse(from) > 31 * DAY) throw new HttpError(400, "diagnostic range must be ordered and at most 31 days");
  return { source, projectID, issueID, runID, from, to,
    after: integer(params, "after", 0, 0, Number.MAX_SAFE_INTEGER), limit: integer(params, "limit", 50, 1, 100) };
}

function integer(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timestamp(raw: string | null, fallback: string): string {
  if (raw === null) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) || !Number.isFinite(Date.parse(raw))
    || new Date(raw).toISOString() !== raw) throw new HttpError(400, "timestamps must be canonical UTC ISO strings");
  return raw;
}

function reflectionRows(db: RunnerDatabase, q: Query): Row[] {
  return db.sqlite.query<Row, (string | number)[]>(`select rowid as cursor, id, issue_id, run_id, status,
    substr(reason,1,1000) as reason, memory_id, attempts, created_at, updated_at
    from pi_memory_reflections where project_id=? and rowid>? and julianday(created_at)>=julianday(?) and julianday(created_at)<=julianday(?)
      and (?=0 or issue_id=?) and (?='' or run_id=?) order by rowid limit ?`)
    .all(q.projectID, q.after, q.from, q.to, q.issueID, q.issueID, q.runID,
      `xw:run:issue_runs:${q.runID}`, q.limit + 1);
}

function eventRows(db: RunnerDatabase, q: Query): Row[] {
  return db.sqlite.query<Row, (string | number)[]>(`select id as cursor, id, issue_id, type, created_at,
    case when length(cast(payload as blob))<=${MAX_JSON_BYTES} then payload else null end as payload
    from issue_events where issue_id=? and id>? and type in (${EVENT_TYPES.map(() => "?").join(",")})
      and julianday(created_at)>=julianday(?) and julianday(created_at)<=julianday(?)
      and (?='' or json_extract(case when json_valid(payload) then payload else '{}' end, '$.issue_run_id')=?)
    order by id limit ?`).all(q.issueID, q.after, ...EVENT_TYPES, q.from, q.to, q.runID, q.runID, q.limit + 1);
}

function actionRows(db: RunnerDatabase, q: Query): Row[] {
  // 旧复盘 Action 没有 issue_id，使用既有会话与最多两次 attempt 的精确绑定。
  return db.sqlite.query<Row, (string | number)[]>(`select e.id as cursor, e.id,
    coalesce(nullif(e.issue_id,0), r.issue_id, 0) as issue_id, r.run_id, e.created_at,
    e.action_id, e.event_type, a.action_type, a.source, e.decision,
    case when length(cast(e.result_json as blob))<=${MAX_JSON_BYTES} then e.result_json else null end as result_json
    from pi_action_events e join pi_actions a on a.id=e.action_id and a.project_id=e.project_id
    left join pi_memory_reflections r on r.project_id=e.project_id
      and e.conversation_id in ('pi-reflection-'||r.id||'-1', 'pi-reflection-'||r.id||'-2')
    where e.project_id=? and e.id>? and a.action_type in ('memory.search','memory.remember')
      and julianday(e.created_at)>=julianday(?) and julianday(e.created_at)<=julianday(?) and (?=0 or e.issue_id=? or r.issue_id=?)
      and (?='' or r.run_id=?) order by e.id limit ?`)
    .all(q.projectID, q.after, q.from, q.to, q.issueID, q.issueID, q.issueID, q.runID,
      `xw:run:issue_runs:${q.runID}`, q.limit + 1);
}

function base(row: Row, source: string) {
  return { cursor: row.cursor, audit_ref: `${source}:${row.id}`, issue_id: row.issue_id || null,
    recorded_at: text(row.created_at) };
}

function reflectionView(row: Row) {
  return { ...base(row, "pi_memory_reflections"), kind: "reflection", reflection_id: text(row.id),
    run_id: text(row.run_id), status: choice(row.status, ["pending", "running", "completed", "skipped", "failed"]),
    reason_code: reflectionReasonCode(row.reason ?? "", row.status ?? ""), attempts: number(row.attempts),
    requested_at: text(row.created_at), updated_at: text(row.updated_at), memory_id: text(row.memory_id),
    write_result: row.memory_id ? "saved_revision_and_operation_in_action_audit" : "unknown",
    cost: unknownCost(), effectiveness: "not_evaluated" };
}

function eventView(row: Row) {
  const payload = object(row.payload);
  const memory = object(payload.memory);
  const retrieval = retrievalView(memory);
  const kind = row.type === EVENT_TYPES[0] ? "reflection_trigger" : row.type === EVENT_TYPES[1] ? "reflection_attempt"
    : row.type === EVENT_TYPES[2] ? "retrieval_snapshot" : row.type === EVENT_TYPES[3] ? "injection" : "executor_reference";
  const refs = kind === "retrieval_snapshot" ? memory.memory_items
    : kind === "injection" ? payload.memory_refs : kind === "executor_reference" ? [payload] : [];
  return { ...base(row, "issue_event"), kind, data_status: dataStatus(row.payload),
    run_id: text(payload.issue_run_id), snapshot_id: text(payload.snapshot_id),
    reflection_id: text(payload.reflection_id), status: choice(payload.status, ["pending", "running", "completed", "skipped", "failed"]),
    reason_code: kind === "retrieval_snapshot" ? retrieval.reason_code : reasonCode(payload.reason_code),
    acceptance_event_id: number(payload.acceptance_event_id), attempt: number(payload.attempt), started_at: text(payload.started_at),
    captured_for: choice(payload.captured_for ?? payload.phase, ["execution", "recovery"]),
    memory_refs: references(refs), applicability: array(payload.applicability).slice(0, 24).map(value => {
      const item = object(value);
      return { ...memoryRef(item), status: choice(item.status,
        ["requires_current_fact_check", "excluded_not_current_candidate", "excluded_revision_changed"]) };
    }),
    retrieval: kind === "retrieval_snapshot" ? retrieval : null,
    cost: { ...unknownCost(), ...usageView(payload.usage),
      elapsed_ms: number(payload.elapsed_ms) ?? (kind === "retrieval_snapshot" ? retrieval.elapsed_ms : null),
      token_estimate: kind === "injection" ? number(payload.prompt_section_token_estimate)
        : kind === "retrieval_snapshot" ? retrieval.token_estimate : null,
      prompt_bytes: number(payload.prompt_section_bytes) },
    attribution: kind === "injection" ? "provider_input_prepared" : kind === "executor_reference" ? "executor_self_report" : null,
    effectiveness: "not_evaluated" };
}

function actionView(row: Row) {
  const result = object(row.result_json);
  const diagnostics = object(result.diagnostics);
  const retrieval = retrievalView(result);
  const search = row.action_type === "memory.search";
  const completed = row.event_type === "execution_result";
  return { ...base(row, "pi_action_event"), kind: search ? "memory_search" : "memory_write", run_id: text(row.run_id),
    action_id: text(row.action_id), action_audit_path: `/api/pi/actions/${encodeURIComponent(row.action_id ?? "")}/events`,
    stage: choice(row.event_type, ["candidate", "gate_decision", "execution_started", "execution_result", "execution_failed"]),
    gate_decision: choice(row.decision, ["execute", "ask", "deny"]), source: text(row.source),
    data_status: dataStatus(row.result_json), rejected: typeof result.rejected === "boolean" ? result.rejected : null,
    reason_code: result.rejected === true ? "memory_operation_rejected" : search && completed ? retrieval.reason_code
      : row.event_type === "execution_failed" ? "call_failed" : "unknown",
    memory_refs: completed ? references(search ? result.items : result.id ? [result] : []) : [],
    write_result: search || !completed ? "unknown" : choice(diagnostics.write_result, ["created", "updated", "unchanged", "rejected"]),
    retrieval: search && completed ? retrieval : null,
    cost: { ...unknownCost(), elapsed_ms: number(diagnostics.elapsed_ms) ?? (search ? retrieval.elapsed_ms : null),
      token_estimate: search ? retrieval.token_estimate : null, scope: "host_memory_operation_only" },
    effectiveness: "not_evaluated" };
}

function retrievalView(value: ObjectValue) {
  const retrieval = object(value.retrieval), limits = object(value.limits), truncation = object(value.truncation_summary);
  const excluded = object(retrieval.excluded);
  return { reason_code: choice(retrieval.reason_code, ["retrieval_budget_disabled", "selected", "token_budget_exhausted",
    "no_memory_in_window", "no_matching_candidate", "pi_selected_none"]),
    elapsed_ms: number(retrieval.elapsed_ms), scanned: number(retrieval.scanned),
    scan_limited: typeof retrieval.scan_limited === "boolean" ? retrieval.scan_limited : null,
    token_budget: number(limits.token_budget), token_estimate: number(limits.token_estimate),
    item_limit: number(limits.item_limit), selected_count: number(truncation.selected_count),
    omitted_by_token_budget: number(truncation.omitted_by_token_budget), omitted_by_item_limit: number(truncation.omitted_by_item_limit),
    omitted_by_candidate_limit: number(retrieval.omitted_by_candidate_limit),
    omitted_by_selection_or_technical_limit: number(retrieval.omitted_by_selection_or_technical_limit),
    excluded: Object.fromEntries(["ineligible", "version_mismatch", "applicability_mismatch", "unrelated"].map(key => [key, number(excluded[key])])) };
}

function memoryRef(value: unknown) {
  const item = object(value), provenance = object(item.provenance), experience = object(item.content);
  return { id: text(item.id), revision: number(item.revision), content_fingerprint: text(item.content_fingerprint),
    version: text(item.version ?? experience.version), selection_stage: choice(item.selection_stage, ["policy", "text_candidate", "pi_selected"]),
    provenance: { source_type: text(provenance.source_type ?? item.source_type), source_id: text(provenance.source_id ?? item.source_id),
      citation_type: text(provenance.citation_type ?? item.citation_type), citation_id: text(provenance.citation_id ?? item.citation_id) } };
}

function references(value: unknown) { return array(value).slice(0, 24).map(memoryRef); }
function unknownCost() { return { elapsed_ms: null as number | null, input_tokens: null as number | null,
  output_tokens: null as number | null, cache_read_tokens: null as number | null, cache_write_tokens: null as number | null,
  model_calls: null as number | null, completed_calls: null as number | null, input_bytes: null as number | null,
  output_bytes: null as number | null, cost_usd: null as number | null, completeness: "unknown" }; }
function usageView(value: unknown) {
  const usage = object(value);
  return { ...Object.fromEntries(Object.keys(unknownCost()).filter(key => key !== "completeness").map(key => [key, number(usage[key])])),
    completeness: choice(usage.completeness, ["reported", "partial"]) };
}
function reasonCode(value: unknown) {
  if (value === "queued") return "queued";
  const codes = ["model_call_budget_exhausted", "model_input_budget_exhausted", "model_input_or_call_budget_exhausted", "model_token_budget_exhausted",
    "tool_input_budget_exhausted", "tool_budget_exhausted", "output_budget_exhausted", "timeout", "worker_stopped",
    "lease_revoked", "pi_reported_no_experience", "call_failed"];
  if (typeof value !== "string") return "unknown";
  if (codes.includes(value)) return value;
  const known = reflectionReasonCode(value, "");
  return known === "call_failed" ? "unknown" : known;
}
function object(value: unknown): ObjectValue {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function choice(value: unknown, values: string[]): string { return typeof value === "string" && values.includes(value) ? value : "unknown"; }
function text(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return containsSensitiveMemoryContent(value) ? "[redacted]" : redactSensitiveText(value).slice(0, 256);
}
function dataStatus(value: string | null | undefined) {
  if (value === null) return "unknown_oversized";
  try { const parsed = JSON.parse(value ?? ""); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "recorded" : "unknown_invalid"; }
  catch { return "unknown_invalid"; }
}
