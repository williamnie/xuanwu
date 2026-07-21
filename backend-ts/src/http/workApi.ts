import type { RunnerDatabase } from "../db/database.ts";
import { getProject, ProjectNotFoundError } from "../db/repositories/projects.ts";
import {
  applyIssueWorkAction,
  countIssueBackedWorks,
  createIssueBackedWork,
  getIssueBackedWork,
  listIssueBackedWorks,
  updateIssueBackedWork,
  workIDToIssueID,
  type IssueWorkAction,
  type IssueWorkMutationResult
} from "../domain/work/issueAdapter.ts";
import {
  PI_WORK_RELATION_KINDS,
  PI_WORK_RELATION_LIFECYCLES,
  listPiWorkRelations,
  type PiWorkRelation
} from "../domain/work/piRelationAdapter.ts";
import {
  WORK_STATUSES,
  WORK_TYPES,
  type WorkLedgerEntry,
  type WorkTransitionAudit
} from "../domain/work/contracts.ts";
import { queryWorkTimeline } from "../domain/work/timeline.ts";
import {
  READINESS_STAGES,
  declareIssueReadinessRequirements,
  readIssueReadiness,
  type ReadinessRequirement,
  type ReadinessRequirementDeclaration
} from "../domain/readiness/contracts.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

const WORK_HTTP_POLICY_REF = "xuanwu-work-http-authenticated-write-v1";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const WORK_HTTP_COMPATIBILITY_POLICY = {
  dual_read: "none",
  final_removal_gate: "P11.05/P11.09-and-G7-and-zero-consumer-and-backup-restore-observation-window",
  read_authority: "issues",
  readiness_authority: "issues.status+work_relations+append-only-structured-Evidence-request-time-projection",
  relation_authority: "pi-carrier-read-projection",
  rollback: "unregister-work-http-routes-without-data-migration",
  structural_relation_write: "unavailable-before-G4",
  target_shadow: "disabled",
  write_authority: "issues-via-work-adapter"
} as const;

type PageInput = {
  page: number;
  page_size: number;
};

export function registerWorkRoutes(router: Router, context: ReadApiContext): void {
  const readDatabase = context.readDatabase ?? context.database;
  router.get("/api/works", (request) => workResponse(() => listResponse(readDatabase, request)));
  router.get("/api/works/board", (request) => workResponse(() => boardResponse(readDatabase, request)));
  router.get("/api/works/:id", (request) => workResponse(() => detailResponse(readDatabase, request)));
  router.get("/api/works/:id/timeline", (request) => (
    workResponse(() => timelineResponse(readDatabase, request))
  ));
  router.get("/api/works/:id/relations", (request) => (
    workResponse(() => workRelationsResponse(readDatabase, request))
  ));
  router.put("/api/works/:id/readiness-requirements", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const body = await objectBody(request);
    assertKeys(body, ["audit", "requirements", "schema_version", "work_id"]);
    const declaration = readinessDeclaration(body, work);
    const result = declareIssueReadinessRequirements(context.database, workIDToIssueID(work.id), declaration);
    kickProject(context, work);
    return {
      compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
      mutation: { event_id: result.event_id, replayed: result.replayed },
      readiness: readIssueReadiness(context.database, workIDToIssueID(work.id)),
      work
    };
  }));
  router.get("/api/work-relations", (request) => (
    workResponse(() => relationListResponse(readDatabase, request))
  ));
  router.post("/api/works", async (request) => workResponse(async () => {
    const body = await objectBody(request);
    assertKeys(body, ["audit", "goal", "project_id", "status", "title", "type"]);
    const projectID = requiredString(body.project_id, "project_id");
    if (!getProject(context.database, projectID)) throw workError(404, "project_not_found", "Project not found");
    const type = optionalString(body.type) || "engineering_task";
    if (!WORK_TYPES.includes(type as typeof WORK_TYPES[number])) {
      throw workError(400, "invalid_request", "type is invalid");
    }
    if (type !== "engineering_task") {
      throw workError(
        409,
        "work_authority_restriction",
        "objective Work creation is unavailable while Issues remain the write authority"
      );
    }
    const status = optionalString(body.status) || "triage";
    if (status !== "triage" && status !== "todo") {
      throw workError(400, "invalid_request", "status must be triage or todo when creating Work");
    }
    const result = createIssueBackedWork(context.database, {
      audit: auditInput(body.audit),
      goal: requiredString(body.goal, "goal"),
      project_id: projectID,
      status,
      title: requiredString(body.title, "title"),
      type
    });
    kickProject(context, result.work);
    return mutationResponse(result, 201);
  }));
  router.patch("/api/works/:id", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const body = await objectBody(request);
    assertKeys(body, ["audit", "expected_revision", "goal", "title"]);
    const patch = {
      ...(Object.hasOwn(body, "goal") ? { goal: requiredString(body.goal, "goal") } : {}),
      ...(Object.hasOwn(body, "title") ? { title: requiredString(body.title, "title") } : {})
    };
    if (Object.keys(patch).length === 0) throw workError(400, "invalid_request", "Work patch is empty");
    const result = updateIssueBackedWork(context.database, {
      audit: auditInput(body.audit),
      expected_revision: revisionInput(body.expected_revision),
      patch,
      shadow_mode: "disabled",
      work_id: work.id
    });
    return mutationResponse(result);
  }));
  router.post("/api/works/:id/actions/:action", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const action = actionInput(request);
    const body = await objectBody(request);
    assertKeys(body, ["audit", "expected_revision"]);
    const result = applyIssueWorkAction(context.database, {
      action,
      audit: auditInput(body.audit),
      expected_revision: revisionInput(body.expected_revision),
      shadow_mode: "disabled",
      work_id: work.id
    });
    if (result.applied) kickProject(context, result.work);
    return mutationResponse(result);
  }));
}

function boardResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const projectID = optionalString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const pageSize = positiveIntegerParam(params.get("page_size"), "page_size", 20, MAX_PAGE_SIZE);
  const sort = enumParam(
    params.get("sort"),
    ["created_at", "status", "title", "updated_at"] as const,
    "updated_at",
    "sort"
  );
  const order = enumParam(params.get("order"), ["asc", "desc"] as const, "desc", "order");
  const page = { page: 1, page_size: pageSize };
  const lanes = Object.fromEntries(WORK_STATUSES.map((status) => {
    const filter = {
      limit: pageSize,
      offset: 0,
      projectId: projectID,
      sort,
      sortOrder: order,
      statuses: [status]
    };
    const total = countIssueBackedWorks(db, filter);
    return [status, pagedItemsResponse(listIssueBackedWorks(db, filter), total, page, {})];
  }));
  return {
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    lanes,
    page_size: pageSize,
    project_id: projectID,
    sort: { field: sort, order }
  };
}

function listResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const projectID = optionalString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const statuses = enumParams(params, "status", WORK_STATUSES);
  const types = enumParams(params, "type", WORK_TYPES);
  const query = optionalString(params.get("q")).toLowerCase();
  const sort = enumParam(
    params.get("sort"),
    ["created_at", "status", "title", "updated_at"] as const,
    "updated_at",
    "sort"
  );
  const order = enumParam(params.get("order"), ["asc", "desc"] as const, "desc", "order");
  const page = pageInput(params);
  const typeMatches = types.length === 0 || types.includes("engineering_task");
  const filter = {
    limit: page.page_size,
    offset: (page.page - 1) * page.page_size,
    projectId: projectID,
    query,
    sort,
    sortOrder: order,
    statuses
  };
  const total = typeMatches ? countIssueBackedWorks(db, filter) : 0;
  const items = typeMatches ? listIssueBackedWorks(db, filter) : [];
  return pagedItemsResponse(items, total, page, {
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    filters: { project_id: projectID, q: query, status: statuses, type: types },
    sort: { field: sort, order }
  });
}

function detailResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const work = requireWork(db, workID(request));
  return {
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    readiness: readIssueReadiness(db, workIDToIssueID(work.id)),
    relations: relationsForWork(db, work.id),
    work
  };
}

function readinessDeclaration(
  body: Record<string, unknown>,
  work: WorkLedgerEntry
): ReadinessRequirementDeclaration {
  if (body.schema_version !== 1) throw workError(400, "invalid_request", "schema_version must be 1");
  const declaredWorkID = requiredString(body.work_id, "work_id");
  if (declaredWorkID !== work.id) throw workError(400, "invalid_request", "work_id must match the route Work");
  if (!Array.isArray(body.requirements) || body.requirements.length === 0) {
    throw workError(400, "invalid_request", "requirements are required");
  }
  return {
    audit: readinessAudit(body.audit),
    requirements: body.requirements.map((value, index) => readinessRequirement(value, index)),
    schema_version: 1,
    work_id: work.id
  };
}

function readinessAudit(value: unknown): ReadinessRequirementDeclaration["audit"] {
  const audit = auditInput(value);
  return {
    actor: audit.actor,
    correlation_id: audit.correlation_id,
    event_id: audit.event_id,
    occurred_at: audit.occurred_at,
    reason: audit.reason
  };
}

function readinessRequirement(value: unknown, index: number): ReadinessRequirement {
  const item = objectValue(value, `requirements[${index}]`);
  assertKeys(item, [
    "environment", "migration_gate", "release_window", "required_stage",
    "runtime_revision", "source_revision", "source_work_id"
  ]);
  const stage = requiredString(item.required_stage, `requirements[${index}].required_stage`);
  if (!READINESS_STAGES.includes(stage as typeof READINESS_STAGES[number])) {
    throw workError(400, "invalid_request", `requirements[${index}].required_stage is invalid`);
  }
  return {
    environment: requiredString(item.environment, `requirements[${index}].environment`),
    ...(optionalString(item.migration_gate) ? { migration_gate: optionalString(item.migration_gate) } : {}),
    release_window: requiredString(item.release_window, `requirements[${index}].release_window`),
    required_stage: stage as ReadinessRequirement["required_stage"],
    runtime_revision: requiredString(item.runtime_revision, `requirements[${index}].runtime_revision`),
    source_revision: requiredString(item.source_revision, `requirements[${index}].source_revision`),
    source_work_id: canonicalWorkID(requiredString(item.source_work_id, `requirements[${index}].source_work_id`))
  };
}

function timelineResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const work = requireWork(db, workID(request));
  const params = new URL(request.url).searchParams;
  try {
    return {
      compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
      ...queryWorkTimeline(db, work.id, {
        cursor: optionalString(params.get("cursor")) || undefined,
        limit: positiveIntegerParam(params.get("limit"), "limit", 50, 500)
      })
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Work timeline cursor")) {
      throw workError(400, "invalid_cursor", error.message);
    }
    throw error;
  }
}

function workRelationsResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const work = requireWork(db, workID(request));
  return {
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    ...relationsForWork(db, work.id),
    work_id: work.id
  };
}

function relationListResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const projectID = optionalString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const rawWorkID = optionalString(params.get("work_id"));
  const workIDFilter = rawWorkID ? canonicalWorkID(rawWorkID) : undefined;
  const kinds = enumParams(params, "kind", PI_WORK_RELATION_KINDS);
  const lifecycles = enumParams(params, "lifecycle", PI_WORK_RELATION_LIFECYCLES);
  const page = pageInput(params);
  const projection = listPiWorkRelations(db, {
    project_id: projectID,
    ...(workIDFilter ? { work_id: workIDFilter } : {})
  });
  const items = projection.relations
    .filter((relation) => kinds.length === 0 || kinds.includes(relation.kind))
    .filter((relation) => lifecycles.length === 0 || lifecycles.includes(relation.lifecycle));
  return pageResponse(items, page, {
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    filters: { kind: kinds, lifecycle: lifecycles, project_id: projectID, work_id: workIDFilter ?? "" },
    unmapped: projection.unmapped
  });
}

function relationsForWork(db: RunnerDatabase, workIDValue: WorkLedgerEntry["id"]): {
  items: PiWorkRelation[];
  total: number;
} {
  const items = listPiWorkRelations(db, { work_id: workIDValue }).relations;
  return { items, total: items.length };
}

function mutationResponse(result: IssueWorkMutationResult, appliedStatus = 200): Response {
  if (!result.applied) {
    return json({
      code: "work_mutation_rejected",
      message: "Work mutation rejected",
      violations: result.violations,
      work: result.work
    }, { status: 409 });
  }
  return json({
    compatibility: WORK_HTTP_COMPATIBILITY_POLICY,
    mutation: {
      applied: true,
      audit_event_id: result.audit_event_id,
      shadow: result.shadow
    },
    work: result.work
  }, { status: appliedStatus });
}

function auditInput(value: unknown): WorkTransitionAudit {
  const audit = objectValue(value, "audit");
  assertKeys(audit, ["actor", "correlation_id", "event_id", "occurred_at", "reason"]);
  const actor = objectValue(audit.actor, "audit.actor");
  assertKeys(actor, ["id", "kind"]);
  const kind = requiredString(actor.kind, "audit.actor.kind");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) {
    throw workError(400, "invalid_request", "audit.actor.kind is invalid");
  }
  const occurredAt = requiredString(audit.occurred_at, "audit.occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw workError(400, "invalid_request", "audit.occurred_at must be a timestamp");
  }
  return {
    actor: { id: requiredString(actor.id, "audit.actor.id"), kind: kind as WorkTransitionAudit["actor"]["kind"] },
    correlation_id: requiredString(audit.correlation_id, "audit.correlation_id"),
    event_id: requiredString(audit.event_id, "audit.event_id"),
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: WORK_HTTP_POLICY_REF },
    occurred_at: occurredAt,
    reason: requiredString(audit.reason, "audit.reason")
  };
}

function actionInput(request: Request): IssueWorkAction {
  const parts = pathParts(request);
  const action = decodeURIComponent(parts[parts.indexOf("actions") + 1] ?? "").trim();
  if (action !== "cancel" && action !== "enqueue" && action !== "retry") {
    throw workError(400, "invalid_request", "Work action must be cancel, enqueue, or retry");
  }
  return action;
}

function requireWork(db: RunnerDatabase, id: string): WorkLedgerEntry {
  const canonical = canonicalWorkID(id);
  const work = getIssueBackedWork(db, canonical);
  if (!work) throw workError(404, "work_not_found", "Work not found");
  return work;
}

function canonicalWorkID(value: string): WorkLedgerEntry["id"] {
  try {
    workIDToIssueID(value);
    return value as WorkLedgerEntry["id"];
  } catch {
    throw workError(400, "invalid_work_id", "Work id is invalid");
  }
}

function workID(request: Request): string {
  const parts = pathParts(request);
  const raw = parts[parts.indexOf("works") + 1] ?? "";
  if (raw === "") throw workError(400, "invalid_work_id", "Work id is invalid");
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw workError(400, "invalid_work_id", "Work id is invalid");
  }
}

function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

function kickProject(context: ReadApiContext, work: WorkLedgerEntry): void {
  if (work.status !== "todo" && work.status !== "cancelled") return;
  const project = getProject(context.database, work.owner.project_id);
  if (!project || project.auto_run !== 1) return;
  startProjectLoop({ bus: context.bus, database: context.database, providers: context.providers }, project.id);
}

function pageResponse<T>(items: T[], page: PageInput, extra: Record<string, unknown>): Record<string, unknown> {
  const start = (page.page - 1) * page.page_size;
  return pagedItemsResponse(items.slice(start, start + page.page_size), items.length, page, extra);
}

function pagedItemsResponse<T>(
  items: T[],
  total: number,
  page: PageInput,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...extra,
    items,
    page: page.page,
    page_size: page.page_size,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / page.page_size)
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
  if (!/^[0-9]+$/.test(raw)) throw workError(400, "invalid_request", `${field} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw workError(400, "invalid_request", `${field} must be a positive integer`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw workError(400, "invalid_request", `${field} must not exceed ${maximum}`);
  }
  return parsed;
}

function enumParams<const T extends readonly string[]>(params: URLSearchParams, key: string, values: T): T[number][] {
  const requested = params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = requested.filter((value) => !values.includes(value as T[number]));
  if (invalid.length > 0) throw workError(400, "invalid_request", `${key} is invalid`);
  return [...new Set(requested)] as T[number][];
}

function enumParam<const T extends readonly string[]>(
  value: string | null,
  values: T,
  fallback: T[number],
  field: string
): T[number] {
  const requested = optionalString(value);
  if (requested === "") return fallback;
  if (!values.includes(requested as T[number])) throw workError(400, "invalid_request", `${field} is invalid`);
  return requested as T[number];
}

function revisionInput(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw workError(400, "invalid_request", "expected_revision must be a non-negative integer");
  }
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw workError(400, "invalid_request", "Request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkHttpError) throw error;
    throw workError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (text === "") throw workError(400, "invalid_request", `${field} is required`);
  return text;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw workError(400, "invalid_request", `Unsupported fields: ${unknown.sort().join(", ")}`);
  }
}

async function workResponse(write: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const output = await write();
    return output instanceof Response ? output : json(output);
  } catch (error) {
    return workErrorResponse(error);
  }
}

class WorkHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkHttpError";
  }
}

function workError(status: number, code: string, message: string): WorkHttpError {
  return new WorkHttpError(status, code, message);
}

function workErrorResponse(error: unknown): Response {
  if (error instanceof WorkHttpError) {
    return json({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ProjectNotFoundError) {
    return json({ code: "project_not_found", message: "Project not found" }, { status: 404 });
  }
  if (error instanceof Error && error.message.includes("conflicts with another command")) {
    return json({
      code: "work_event_conflict",
      message: "Work audit event conflicts with another command"
    }, { status: 409 });
  }
  return json({ code: "internal_error", message: "Internal server error" }, { status: 500 });
}
