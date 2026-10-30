import { attachWorkSchedules } from "./workSchedule.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { countIssueBackedWorks, getIssueBackedWork, listIssueBackedWorks, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { WORK_STATUSES, WORK_TYPES, type WorkLedgerEntry } from "../../domain/work/contracts.ts";
import { queryWorkTimeline } from "../../domain/work/timeline.ts";
import { readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { readHumanFeedback } from "../../domain/review/humanFeedback.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { cleanString } from "../../util/values.ts";
import { workSourceParam, workError, positiveIntegerParam, MAX_PAGE_SIZE, enumParam, enumParams, pagedItemsResponse, pageInput, workFilterFingerprint, decodeWorkCursor, WorkHttpError } from "./workApi.decodeWorkCursor.ts";
import type { WorkCursorV1 } from "./workApi.model.ts";

export function boardResponse(db: RunnerDatabase, request: Request, context: ReadApiContext): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const source = workSourceParam(params);
  const query = cleanString(params.get("q")).toLowerCase();
  const projectID = cleanString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const pageSize = positiveIntegerParam(params.get("page_size"), "page_size", 20, MAX_PAGE_SIZE);
  const sort = enumParam(
    params.get("sort"),
    ["created_at", "status", "title", "updated_at"] as const,
    "updated_at",
    "sort"
  );
  const order = enumParam(params.get("order"), ["asc", "desc"] as const, "desc", "order");
  const requestedStatuses = enumParams(params, "status", WORK_STATUSES);
  const statuses = requestedStatuses.length > 0 ? requestedStatuses : [...WORK_STATUSES];
  const page = { page: 1, page_size: pageSize };
  const lanes = Object.fromEntries(statuses.map((status) => {
    const filter = {
      limit: pageSize,
      offset: 0,
      projectId: projectID,
      sort,
      sortOrder: order,
      source,
      query,
      statuses: [status]
    };
    const total = countIssueBackedWorks(db, filter);
    return [status, pagedItemsResponse(attachWorkSchedules(context, listIssueBackedWorks(db, filter)), total, page, {})];
  }));
  return {
    lanes,
    page_size: pageSize,
    project_id: projectID,
    sort: { field: sort, order }
  };
}

export function listResponse(db: RunnerDatabase, request: Request, context: ReadApiContext): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const projectID = cleanString(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) throw workError(404, "project_not_found", "Project not found");
  const statuses = enumParams(params, "status", WORK_STATUSES);
  const types = enumParams(params, "type", WORK_TYPES);
  const source = workSourceParam(params);
  const query = cleanString(params.get("q")).toLowerCase();
  const sort = enumParam(
    params.get("sort"),
    ["created_at", "status", "title", "updated_at"] as const,
    "updated_at",
    "sort"
  );
  const order = enumParam(params.get("order"), ["asc", "desc"] as const, "desc", "order");
  const cursorText = cleanString(params.get("cursor"));
  if (cursorText && (sort !== "updated_at" || order !== "desc")) {
    throw workError(400, "cursor_sort_unsupported", "cursor only supports updated_at desc");
  }
  const page = pageInput(params);
  const fingerprint = workFilterFingerprint({ projectID, query, source, statuses, types });
  const cursor = cursorText ? decodeWorkCursor(cursorText, fingerprint) : undefined;
  const typeMatches = types.length === 0 || types.includes("engineering_task");
  const filter = {
    cursorIssueId: cursor?.issue_id,
    cursorUpdatedAt: cursor?.updated_at,
    limit: cursor ? page.page_size + 1 : page.page_size,
    offset: cursor ? 0 : (page.page - 1) * page.page_size,
    projectId: projectID,
    query,
    sort,
    sortOrder: order,
    source,
    statuses
  };
  const total = typeMatches ? countIssueBackedWorks(db, {
    ...filter,
    cursorIssueId: undefined,
    cursorUpdatedAt: undefined,
    limit: undefined,
    offset: undefined
  }) : 0;
  const loaded = typeMatches ? listIssueBackedWorks(db, filter) : [];
  const items = cursor ? loaded.slice(0, page.page_size) : loaded;
  const hasMore = cursor ? loaded.length > page.page_size : page.page * page.page_size < total;
  const last = items.at(-1);
  return pagedItemsResponse(attachWorkSchedules(context, items), total, page, {
    filters: { project_id: projectID, q: query, status: statuses, type: types, ...(source ? { source } : {}) },
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeWorkCursor({
      filter_fingerprint: fingerprint,
      issue_id: workIDToIssueID(last.id),
      updated_at: last.updated_at,
      version: 1
    }) : "",
    sort: { field: sort, order }
  });
}

export function detailResponse(db: RunnerDatabase, request: Request, context: ReadApiContext): Record<string, unknown> {
  const work = requireWork(db, workID(request));
  const decision = readIssueDecisionProjection(db, workIDToIssueID(work.id));
  return {
    decision,
    feedback: readHumanFeedback(db, workIDToIssueID(work.id), decision),
    work: attachWorkSchedules(context, [work])[0]
  };
}

export function timelineResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const work = requireWork(db, workID(request));
  const params = new URL(request.url).searchParams;
  try {
    const result = queryWorkTimeline(db, work.id, {
        cursor: cleanString(params.get("cursor")) || undefined,
        limit: positiveIntegerParam(params.get("limit"), "limit", 50, 500)
      });
    return {
      has_more: result.has_more,
      items: result.items.map(compactTimelineItem),
      next_cursor: result.next_cursor
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Work timeline cursor")) {
      throw workError(400, "invalid_cursor", error.message);
    }
    throw error;
  }
}

export function compactTimelineItem(item: ReturnType<typeof queryWorkTimeline>["items"][number]) {
  return {
    id: item.id,
    kind: item.kind,
    occurred_at: item.occurred_at,
    status: item.status,
    summary: item.summary,
    title: item.title
  };
}

export function requireWork(db: RunnerDatabase, id: string): WorkLedgerEntry {
  const canonical = canonicalWorkID(id);
  const work = getIssueBackedWork(db, canonical);
  if (!work) throw workError(404, "work_not_found", "Work not found");
  return work;
}

export function canonicalWorkID(value: string): WorkLedgerEntry["id"] {
  try {
    workIDToIssueID(value);
    return value as WorkLedgerEntry["id"];
  } catch {
    throw workError(400, "invalid_work_id", "Work id is invalid");
  }
}

export function workID(request: Request): string {
  const parts = pathParts(request);
  const raw = parts[parts.indexOf("works") + 1] ?? "";
  if (raw === "") throw workError(400, "invalid_work_id", "Work id is invalid");
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw workError(400, "invalid_work_id", "Work id is invalid");
  }
}

export function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

export function encodeWorkCursor(cursor: WorkCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
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

export function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw workError(400, "invalid_request", `Unsupported fields: ${unknown.sort().join(", ")}`);
  }
}
