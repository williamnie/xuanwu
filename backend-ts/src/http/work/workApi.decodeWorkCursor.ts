import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { getProject, ProjectNotFoundError } from "../../db/repositories/projects.ts";
import { json } from "../errors.ts";
import { readWorkSummary, WORK_SUMMARY_CONTRACT, WorkSummaryCapacityError } from "../../db/repositories/workSummary.ts";
import { cleanString } from "../../util/values.ts";
import type { PageInput, WorkCursorV1 } from "./workApi.model.ts";

export const WORK_HTTP_POLICY_REF = "xuanwu-work-http-authenticated-write-v1";

export const DEFAULT_PAGE_SIZE = 50;

export const MAX_PAGE_SIZE = 100;

export const MAX_CURSOR_BYTES = 2_048;

export const WORK_WRITE_AUTHORITY = "issues-via-work-adapter";

export function summaryResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const projectID = cleanString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const requestedIncludeProjects = booleanParam(params.get("include_projects"), "include_projects", !projectID);
  if (projectID && requestedIncludeProjects) {
    throw workError(400, "invalid_request", "include_projects=true is invalid with project_id");
  }
  try {
    return {
      contract: WORK_SUMMARY_CONTRACT,
      generated_at: new Date().toISOString(),
      read_authority: WORK_WRITE_AUTHORITY,
      ...readWorkSummary(db, { includeProjects: requestedIncludeProjects, projectId: projectID })
    };
  } catch (error) {
    if (error instanceof WorkSummaryCapacityError) {
      throw workError(409, "project_summary_capacity_exceeded", error.message);
    }
    throw error;
  }
}

export function pagedItemsResponse<T>(
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

export function pageInput(params: URLSearchParams): PageInput {
  return {
    page: positiveIntegerParam(params.get("page"), "page", 1),
    page_size: positiveIntegerParam(params.get("page_size"), "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
}

export function workFilterFingerprint(input: {
  projectID: string;
  query: string;
  source?: "github" | "manual";
  statuses: string[];
  types: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    project_id: input.projectID,
    q: input.query,
    ...(input.source ? { source: input.source } : {}),
    status: [...input.statuses].sort(),
    type: [...input.types].sort()
  })).digest("hex");
}

export function workSourceParam(params: URLSearchParams): "github" | "manual" | undefined {
  if (!params.has("source")) return undefined;
  const values = params.getAll("source");
  if (values.length !== 1 || !["github", "manual"].includes(values[0]!)) {
    throw workError(400, "invalid_request", "source must be github or manual");
  }
  return values[0] as "github" | "manual";
}

export function decodeWorkCursor(value: string, fingerprint: string): WorkCursorV1 {
  if (value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw workError(400, "invalid_cursor", "cursor is invalid");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("non-canonical cursor");
    const cursor = JSON.parse(decoded) as Record<string, unknown>;
    const keys = Object.keys(cursor).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["filter_fingerprint", "issue_id", "updated_at", "version"])) {
      throw new Error("cursor keys are invalid");
    }
    if (cursor.version !== 1 || typeof cursor.filter_fingerprint !== "string" || cursor.filter_fingerprint !== fingerprint) {
      throw new Error("cursor scope is invalid");
    }
    if (!Number.isSafeInteger(cursor.issue_id) || Number(cursor.issue_id) <= 0) throw new Error("cursor issue id is invalid");
    if (typeof cursor.updated_at !== "string" || cursor.updated_at.length === 0 || cursor.updated_at.length > 64
      || !Number.isFinite(Date.parse(cursor.updated_at))) throw new Error("cursor timestamp is invalid");
    return cursor as unknown as WorkCursorV1;
  } catch {
    throw workError(400, "invalid_cursor", "cursor is invalid or does not match the current filters");
  }
}

export function booleanParam(value: string | null, field: string, fallback: boolean): boolean {
  const raw = cleanString(value).toLowerCase();
  if (raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw workError(400, "invalid_request", `${field} must be true or false`);
}

export function positiveIntegerParam(value: string | null, field: string, fallback: number, maximum?: number): number {
  const raw = cleanString(value);
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

export function enumParams<const T extends readonly string[]>(params: URLSearchParams, key: string, values: T): T[number][] {
  const requested = params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = requested.filter((value) => !values.includes(value as T[number]));
  if (invalid.length > 0) throw workError(400, "invalid_request", `${key} is invalid`);
  return [...new Set(requested)] as T[number][];
}

export function enumParam<const T extends readonly string[]>(
  value: string | null,
  values: T,
  fallback: T[number],
  field: string
): T[number] {
  const requested = cleanString(value);
  if (requested === "") return fallback;
  if (!values.includes(requested as T[number])) throw workError(400, "invalid_request", `${field} is invalid`);
  return requested as T[number];
}

export async function workResponse(write: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const output = await write();
    return output instanceof Response ? output : json(output);
  } catch (error) {
    return workErrorResponse(error);
  }
}

export class WorkHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkHttpError";
  }
}

export function workError(status: number, code: string, message: string): WorkHttpError {
  return new WorkHttpError(status, code, message);
}

export function workErrorResponse(error: unknown): Response {
  if (error instanceof WorkHttpError) {
    return json({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ProjectNotFoundError) {
    return json({ code: "project_not_found", message: "Project not found" }, { status: 404 });
  }
  if (error instanceof Error && (
    error.message.startsWith("依赖 Issue #") ||
    error.message.startsWith("depends_on_issue_ids")
  )) {
    return json({ code: "invalid_request", message: error.message }, { status: 400 });
  }
  if (error instanceof Error && error.message.includes("conflicts with another command")) {
    return json({
      code: "work_event_conflict",
      message: "Work audit event conflicts with another command"
    }, { status: 409 });
  }
  return json({ code: "internal_error", message: "Internal server error" }, { status: 500 });
}
