import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  countRuns,
  getRun,
  listRuns,
  type RunAttemptView,
  type RunDetail,
  type RunListFilter
} from "../db/repositories/runs.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import {
  completeRunAttemptStart,
  completeRunInterrupt,
  failRunAttemptStart,
  failRunInterrupt,
  prepareRunAttempt,
  prepareRunInterrupt,
  requestNewRun,
  RunCommandConflictError,
  RunCommandValidationError,
  type PreparedProviderMutation
} from "../domain/run/service.ts";
import {
  RUN_STATUSES,
  type RunID,
  type RunStatus,
  type RunTransitionAudit,
  type WorkID
} from "../domain/run/contracts.ts";
import {
  isExecutorProviderId,
  type ExecutorProvider,
  type ExecutorProviderId,
  type SessionMessageResult
} from "../providers/types.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const RUN_LIST_SLOW_THRESHOLD_MS = 250;
const RUN_HTTP_POLICY_REF = "xuanwu-run-http-authenticated-control-v1";

export const RUN_READ_AUTHORITY = "issue_runs";
export const RUN_WRITE_AUTHORITY = "domain-run-command-service-over-issue_runs";

type PageInput = { page: number; page_size: number };
type RunAction = "interrupt" | "resume" | "retry";

export function registerRunRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/runs", (request) => runResponse(() => listResponse(context, request), request));
  router.get("/api/runs/:id", (request) => runResponse(() => detailResponse(context, request)));
  router.post("/api/runs/:id/actions/:action", async (request) => runResponse(async () => {
    const run = requireRun(context, runID(request));
    const action = actionInput(request);
    const body = await objectBody(request);
    if (action === "interrupt") return interruptRun(context, run, body);
    if (action === "resume") return resumeRun(context, run, body);
    return retryRun(context, run, body);
  }));
}

export function slowRunListLogEntry(
  request: Request,
  durationMs: number,
  status: number
): Record<string, unknown> | undefined {
  if (durationMs < RUN_LIST_SLOW_THRESHOLD_MS) return undefined;
  const params = new URL(request.url).searchParams;
  return {
    duration_ms: Math.round(durationMs),
    event: "runner.run_list_slow",
    page: safePositiveInteger(params.get("page"), 1),
    page_size: safePositiveInteger(params.get("page_size"), DEFAULT_PAGE_SIZE),
    project_filter: Boolean(optionalString(params.get("project_id"))),
    provider_filter_count: params.getAll("provider").filter(Boolean).length,
    status,
    status_filter_count: params.getAll("status").filter(Boolean).length,
    work_filter: Boolean(optionalString(params.get("work_id")))
  };
}

function safePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listResponse(context: ReadApiContext, request: Request): Record<string, unknown> {
  const database = context.readDatabase ?? context.database;
  const params = new URL(request.url).searchParams;
  const projectID = optionalString(params.get("project_id"));
  if (projectID && !getProject(database, projectID)) {
    throw runError(404, "project_not_found", "Project not found");
  }
  const workIDValue = optionalString(params.get("work_id"));
  const workIDFilter = workIDValue ? canonicalWorkID(workIDValue) : undefined;
  const providers = stringParams(params, "provider");
  const statuses = enumParams(params, "status", RUN_STATUSES);
  const sort = enumParam(
    params.get("sort"),
    ["created_at", "provider", "status", "updated_at"] as const,
    "updated_at",
    "sort"
  );
  const order = enumParam(params.get("order"), ["asc", "desc"] as const, "desc", "order");
  const page = pageInput(params);
  const filter: RunListFilter = {
    limit: page.page_size,
    offset: (page.page - 1) * page.page_size,
    order,
    project_id: projectID,
    providers,
    sort,
    statuses,
    ...(workIDFilter ? { work_id: workIDFilter } : {})
  };
  const total = countRuns(database, filter);
  return {
    filters: {
      project_id: projectID,
      provider: providers,
      status: statuses,
      work_id: workIDFilter ?? ""
    },
    items: listRuns(database, filter).map(publicRun),
    page: page.page,
    page_size: page.page_size,
    sort: { field: sort, order },
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / page.page_size)
  };
}

function detailResponse(context: ReadApiContext, request: Request): Record<string, unknown> {
  return {
    run: publicRun(requireRun(context, runID(request), context.readDatabase ?? context.database))
  };
}

async function interruptRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Promise<Response | Record<string, unknown>> {
  assertKeys(body, ["audit", "expected_attempt_revision", "expected_revision"]);
  const attempt = latestAttempt(run);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const expectedAttemptRevision = revisionInput(body.expected_attempt_revision, "expected_attempt_revision");
  const audit = auditInput(body.audit);
  const provider = controlProvider(context, attempt, "interrupt");
  const sessionID = requiredControlRef(attempt.provider_ref.session_ref, "interrupt requires provider session ref");
  const turnID = requiredControlRef(attempt.provider_ref.turn_ref, "interrupt requires provider turn ref");
  const prepared = prepareRunInterrupt(context.database, {
    attempt_id: attempt.id,
    audit,
    expected_attempt_revision: expectedAttemptRevision,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    provider_ref: {
      invocation_ref: attempt.provider_ref.invocation_ref || run.legacy.id,
      provider: provider.id,
      session_ref: sessionID,
      turn_ref: turnID
    },
    run_id: run.id
  });
  if (!prepared.should_invoke) return replayResponse(context, run.id, "interrupt", audit.event_id, prepared);
  try {
    await provider.interrupt?.({
      reason: `run_http:${audit.event_id}`,
      session: { provider: provider.id, sessionId: sessionID, turnId: turnID }
    });
  } catch (error) {
    failRunInterrupt(context.database, audit.event_id, sanitizedError(error));
    throw runError(502, "provider_control_failed", "Provider interrupt failed");
  }
  completeRunInterrupt(context.database, audit.event_id);
  return mutationResponse(context, run.id, {
    action: "interrupt",
    audit_event_id: audit.event_id,
    replayed: false
  });
}

async function resumeRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Promise<Response | Record<string, unknown>> {
  assertKeys(body, ["audit", "expected_attempt_revision", "expected_revision", "prompt"]);
  const attempt = latestAttempt(run);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const expectedAttemptRevision = revisionInput(body.expected_attempt_revision, "expected_attempt_revision");
  const prompt = requiredString(body.prompt, "prompt");
  const audit = auditInput(body.audit);
  const provider = controlProvider(context, attempt, "resume_session");
  const sessionID = requiredControlRef(attempt.provider_ref.session_ref, "resume requires provider session ref");
  const prepared = prepareRunAttempt(context.database, {
    audit,
    expected_attempt_revision: expectedAttemptRevision,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    kind: "resume",
    previous_attempt_terminal: {
      reason: "previous provider turn completed before authenticated Run resume",
      source_ref: `run-http:${audit.event_id}:precondition`,
      status: "succeeded"
    },
    provider_ref: { provider: provider.id, session_ref: sessionID },
    run_id: run.id
  });
  if (!prepared.should_invoke) return replayResponse(context, run.id, "resume", audit.event_id, prepared);
  let providerSessionID: string;
  let turnID: string;
  try {
    const result = await provider.sendSessionMessage?.({ prompt, sessionId: sessionID }) as SessionMessageResult;
    providerSessionID = optionalString(result.provider_session_id) || optionalString(result.sessionId) || sessionID;
    turnID = requiredString(result.turn_id, "provider turn id");
  } catch (error) {
    failRunAttemptStart(context.database, audit.event_id, sanitizedError(error));
    throw runError(502, "provider_control_failed", "Provider resume failed");
  }
  completeRunAttemptStart(context.database, audit.event_id, {
    invocation_ref: `${provider.id}:${providerSessionID}:${turnID}`,
    provider_session_id: providerSessionID,
    provider_turn_id: turnID
  });
  persistResumeRuntime(context, run, audit.event_id, provider.id, providerSessionID, turnID);
  return mutationResponse(context, run.id, {
    action: "resume",
    audit_event_id: audit.event_id,
    replayed: false
  });
}

function retryRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Response | Record<string, unknown> {
  assertKeys(body, ["audit", "expected_revision"]);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const audit = auditInput(body.audit);
  const latest = latestAttempt(run);
  const operation = run.status && ["succeeded", "failed", "cancelled"].includes(run.status)
    ? "retry"
    : latest.status === "interrupted" ? "supersede" : "retry";
  const result = requestNewRun(context.database, {
    audit,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    operation,
    run_id: run.id
  });
  if (!result.applied) {
    return json({
      code: "run_precondition_failed",
      message: "Run retry rejected",
      mutation: { action: "retry", audit_event_id: audit.event_id, operation },
      violations: result.violations
    }, { status: 409 });
  }
  kickProject(context, run.project_id);
  return mutationResponse(context, run.id, {
    action: "retry",
    audit_event_id: audit.event_id,
    operation,
    replayed: result.replayed,
    requested_sequence: result.requested_sequence
  });
}

function replayResponse(
  context: ReadApiContext,
  runIDValue: RunID,
  action: RunAction,
  eventID: string,
  prepared: PreparedProviderMutation
): Response | Record<string, unknown> {
  if (!prepared.completed) {
    return json({
      code: "run_control_pending",
      message: "Run control intent is pending provider outcome and will not be invoked twice",
      mutation: { action, audit_event_id: eventID, pending: true, replayed: true },
      run: requireRun(context, runIDValue)
    }, { status: 202 });
  }
  return mutationResponse(context, runIDValue, {
    action,
    audit_event_id: eventID,
    replayed: true
  });
}

function mutationResponse(
  context: ReadApiContext,
  id: RunID,
  mutation: Record<string, unknown>
): Record<string, unknown> {
  return {
    mutation: { applied: true, ...mutation },
    run: publicRun(requireRun(context, id))
  };
}

function publicRun<T extends RunDetail | Omit<RunDetail, "attempts">>(run: T): Omit<T, "legacy"> {
  const { legacy: _legacy, ...publicValue } = run;
  return publicValue;
}

function persistResumeRuntime(
  context: ReadApiContext,
  run: RunDetail,
  eventID: string,
  provider: ExecutorProviderId,
  sessionID: string,
  turnID: string
): void {
  const issueID = issueIDFromWorkID(run.work_id);
  updateIssueRuntime(context.database, issueID, {
    issue_run_id: run.legacy.id,
    metadata: { run_http_event_id: eventID, run_http_resume: true },
    provider,
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  upsertAgentSession(context.database, {
    issue_id: issueID,
    project_id: run.project_id,
    provider,
    provider_session_id: sessionID,
    raw_ref: { provider_turn_id: turnID, run_http_event_id: eventID },
    status: "running"
  });
}

function controlProvider(
  context: ReadApiContext,
  attempt: RunAttemptView,
  capability: "interrupt" | "resume_session"
): ExecutorProvider {
  const providerID = attempt.provider_ref.provider;
  if (!isExecutorProviderId(providerID)) {
    throw runError(409, "provider_control_unavailable", `Provider ${providerID} is not controllable`);
  }
  const provider = context.providers?.[providerID];
  const supported = capability === "interrupt" ? provider?.interrupt : provider?.sendSessionMessage;
  if (!provider || !supported || !provider.capabilities.includes(capability)) {
    throw runError(409, "provider_control_unavailable", `Provider ${providerID} does not support ${capability}`);
  }
  return provider;
}

function latestAttempt(run: RunDetail): RunAttemptView {
  const attempt = run.attempts.at(-1);
  if (!attempt) throw runError(409, "run_attempt_missing", "Run has no Attempt");
  return attempt;
}

function requireRun(context: ReadApiContext, id: RunID, database = context.database): RunDetail {
  const run = getRun(database, id);
  if (!run) throw runError(404, "run_not_found", "Run not found");
  return run;
}

function runID(request: Request): RunID {
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

function canonicalWorkID(value: string): WorkID {
  if (!/^xw:work:issues:[1-9][0-9]*$/.test(value)) {
    throw runError(400, "invalid_work_id", "Work id is invalid");
  }
  return value as WorkID;
}

function issueIDFromWorkID(value: WorkID): number {
  const id = Number(value.slice("xw:work:issues:".length));
  if (!Number.isSafeInteger(id) || id <= 0) throw runError(500, "run_mapping_error", "Run Work mapping is invalid");
  return id;
}

function actionInput(request: Request): RunAction {
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

function pathValue(request: Request, preceding: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts[parts.indexOf(preceding) + 1] ?? "";
}

function auditInput(value: unknown): RunTransitionAudit {
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

function pageInput(params: URLSearchParams): PageInput {
  return {
    page: positiveIntegerParam(params.get("page"), "page", 1),
    page_size: positiveIntegerParam(params.get("page_size"), "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
}

function positiveIntegerParam(value: string | null, field: string, fallback: number, maximum?: number): number {
  const raw = optionalString(value);
  if (raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw runError(400, "invalid_request", `${field} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw runError(400, "invalid_request", `${field} must be a positive integer`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw runError(400, "invalid_request", `${field} must not exceed ${maximum}`);
  }
  return parsed;
}

function stringParams(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
}

function enumParams<const T extends readonly string[]>(params: URLSearchParams, key: string, values: T): T[number][] {
  const requested = stringParams(params, key);
  if (requested.some((value) => !values.includes(value as T[number]))) {
    throw runError(400, "invalid_request", `${key} is invalid`);
  }
  return requested as T[number][];
}

function enumParam<const T extends readonly string[]>(
  value: string | null,
  values: T,
  fallback: T[number],
  field: string
): T[number] {
  const requested = optionalString(value);
  if (requested === "") return fallback;
  if (!values.includes(requested as T[number])) throw runError(400, "invalid_request", `${field} is invalid`);
  return requested as T[number];
}

function revisionInput(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw runError(400, "invalid_request", `${field} must be a non-negative integer`);
  }
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
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

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (text === "") throw runError(400, "invalid_request", `${field} is required`);
  return text;
}

function requiredControlRef(value: unknown, message: string): string {
  const text = optionalString(value);
  if (!text) throw runError(409, "provider_control_unavailable", message);
  return text;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw runError(400, "invalid_request", `Unsupported fields: ${unknown.sort().join(", ")}`);
  }
}

function kickProject(context: ReadApiContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  if (!project || project.auto_run !== 1) return;
  startProjectLoop({
    bus: context.bus,
    database: context.database,
    providers: context.providers
  }, project.id);
}

function sanitizedError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSensitiveText(message));
}

async function runResponse(write: () => unknown | Promise<unknown>, slowListRequest?: Request): Promise<Response> {
  const startedAt = performance.now();
  let response: Response;
  try {
    const output = await write();
    response = output instanceof Response ? output : json(output);
  } catch (error) {
    response = runErrorResponse(error);
  }
  if (slowListRequest) {
    const entry = slowRunListLogEntry(slowListRequest, performance.now() - startedAt, response.status);
    if (entry) console.warn(JSON.stringify(entry));
  }
  return response;
}

class RunHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RunHttpError";
  }
}

function runError(status: number, code: string, message: string): RunHttpError {
  return new RunHttpError(status, code, message);
}

function runErrorResponse(error: unknown): Response {
  if (error instanceof RunHttpError) {
    return json({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RunCommandConflictError) {
    return json({ code: "run_event_conflict", message: "Run audit event conflicts with another command" }, { status: 409 });
  }
  if (error instanceof RunCommandValidationError) {
    return json({ code: "run_precondition_failed", message: error.message }, { status: 409 });
  }
  return json({ code: "internal_error", message: "Internal server error" }, { status: 500 });
}
