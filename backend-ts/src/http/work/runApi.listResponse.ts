import { getProject } from "../../db/repositories/projects.ts";
import { countRuns, getRun, listRuns, type RunDetail, type RunListFilter } from "../../db/repositories/runs.ts";
import { RunCommandConflictError, RunCommandValidationError } from "../../domain/run/lifecycleStore.ts";
import { RUN_STATUSES, type RunID, type WorkID } from "../../domain/run/contracts.ts";
import { json } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { cleanString } from "../../util/values.ts";
import type { PageInput } from "./runApi.model.ts";

export const DEFAULT_PAGE_SIZE = 50;

export const MAX_PAGE_SIZE = 100;

export const RUN_LIST_SLOW_THRESHOLD_MS = 250;

export const RUN_HTTP_POLICY_REF = "xuanwu-run-http-authenticated-control-v1";

export const RUN_READ_AUTHORITY = "issue_runs";

export const RUN_WRITE_AUTHORITY = "domain-run-command-service-over-issue_runs";

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
    project_filter: Boolean(cleanString(params.get("project_id"))),
    provider_filter_count: params.getAll("provider").filter(Boolean).length,
    status,
    status_filter_count: params.getAll("status").filter(Boolean).length,
    work_filter: Boolean(cleanString(params.get("work_id")))
  };
}

export function safePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function listResponse(context: ReadApiContext, request: Request): Record<string, unknown> {
  const database = context.readDatabase ?? context.database;
  const params = new URL(request.url).searchParams;
  const projectID = cleanString(params.get("project_id"));
  if (projectID && !getProject(database, projectID)) {
    throw runError(404, "project_not_found", "Project not found");
  }
  const workIDValue = cleanString(params.get("work_id"));
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

export function publicRun<T extends RunDetail | Omit<RunDetail, "attempts">>(run: T): Omit<T, "legacy"> {
  const { legacy: _legacy, ...publicValue } = run;
  return publicValue;
}

export function requireRun(context: ReadApiContext, id: RunID, database = context.database): RunDetail {
  const run = getRun(database, id);
  if (!run) throw runError(404, "run_not_found", "Run not found");
  return run;
}

export function canonicalWorkID(value: string): WorkID {
  if (!/^xw:work:issues:[1-9][0-9]*$/.test(value)) {
    throw runError(400, "invalid_work_id", "Work id is invalid");
  }
  return value as WorkID;
}

export function pageInput(params: URLSearchParams): PageInput {
  return {
    page: positiveIntegerParam(params.get("page"), "page", 1),
    page_size: positiveIntegerParam(params.get("page_size"), "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
}

export function positiveIntegerParam(value: string | null, field: string, fallback: number, maximum?: number): number {
  const raw = cleanString(value);
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

export function stringParams(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function enumParams<const T extends readonly string[]>(params: URLSearchParams, key: string, values: T): T[number][] {
  const requested = stringParams(params, key);
  if (requested.some((value) => !values.includes(value as T[number]))) {
    throw runError(400, "invalid_request", `${key} is invalid`);
  }
  return requested as T[number][];
}

export function enumParam<const T extends readonly string[]>(
  value: string | null,
  values: T,
  fallback: T[number],
  field: string
): T[number] {
  const requested = cleanString(value);
  if (requested === "") return fallback;
  if (!values.includes(requested as T[number])) throw runError(400, "invalid_request", `${field} is invalid`);
  return requested as T[number];
}

export async function runResponse(write: () => unknown | Promise<unknown>, slowListRequest?: Request): Promise<Response> {
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

export class RunHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RunHttpError";
  }
}

export function runError(status: number, code: string, message: string): RunHttpError {
  return new RunHttpError(status, code, message);
}

export function runErrorResponse(error: unknown): Response {
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
