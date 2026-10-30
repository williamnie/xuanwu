import { getIssue } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { issueIDsForRun, issueIDsForSession, runIDsForSession } from "../../db/repositories/evidence.ts";
import { EVIDENCE_STATUSES, type EvidenceRecord } from "../../domain/evidence/contracts.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { json } from "../errors.ts";
import type { ParsedFilter } from "./evidenceApi.model.ts";

export const DEFAULT_LIMIT = 25;

export const MAX_LIMIT = 100;

export const SUMMARY_LIMIT = 320;

export const EVIDENCE_KIND_PATTERN = /^[a-z][a-z0-9_.-]*$/;

export const EVIDENCE_HTTP_COMPATIBILITY_POLICY = {
  artifact_authority: "content-addressed-collector-artifacts-with-authenticated-download",
  dual_read: "W2-structured-primary-with-targeted-W1-projection-fallback-for-at-most-two-release-windows",
  dual_write: "none-raw-authority-and-structured-projection-have-distinct-responsibilities",
  fact_authority: "originating-command-git-http-browser-or-human-authority",
  final_removal_gate: "P11.03/P11.06-and-G7-and-zero-legacy-consumer-for-one-release-and-artifact-restore-rehearsal",
  read_authority: "issue_events:evidence.recorded.v1",
  rollback: "unregister-evidence-routes-and-stop-new-structured-projection-without-deleting-events-or-artifacts"
} as const;

export function parsedFilter(db: RunnerDatabase, request: Request): ParsedFilter {
  const params = new URL(request.url).searchParams;
  const projectID = optionalText(params.get("project_id"));
  if (projectID && !getProject(db, projectID)) {
    throw evidenceError(404, "project_not_found", "Project not found");
  }
  const issueSets: number[][] = [];
  const issueIDText = optionalText(params.get("issue_id"));
  if (issueIDText) {
    const issueID = positiveInteger(issueIDText, "issue_id");
    if (!getIssue(db, issueID)) throw evidenceError(404, "issue_not_found", "Issue not found");
    issueSets.push([issueID]);
  }
  const workID = optionalText(params.get("work_id"));
  if (workID) {
    const issueID = issueIDFromWorkID(workID);
    if (!issueID) throw evidenceError(400, "invalid_work_id", "Work id is invalid");
    if (!getIssue(db, issueID)) throw evidenceError(404, "work_not_found", "Work not found");
    issueSets.push([issueID]);
  }
  const requestedRunIDs = stringParams(params, "run_id");
  const requestedRunIssueIDs: number[] = [];
  for (const runID of requestedRunIDs) {
    if (!/^xw:run:issue_runs:.+$/.test(runID)) {
      throw evidenceError(400, "invalid_run_id", "Run id is invalid");
    }
    const issueIDs = issueIDsForRun(db, runID);
    if (issueIDs.length === 0) throw evidenceError(404, "run_not_found", "Run not found");
    requestedRunIssueIDs.push(...issueIDs);
  }
  if (requestedRunIDs.length > 0) issueSets.push([...new Set(requestedRunIssueIDs)]);
  const sessionRef = optionalText(params.get("session_ref"));
  const sessionRunIDs = sessionRef ? runIDsForSession(db, sessionRef) : [];
  if (sessionRef) issueSets.push(issueIDsForSession(db, sessionRef));
  const issueIDs = intersect(issueSets);
  const runIDs = intersectStrings([
    ...(requestedRunIDs.length > 0 ? [requestedRunIDs] : []),
    ...(sessionRef ? [sessionRunIDs] : [])
  ]);
  const matchNone = (issueSets.length > 0 && issueIDs.length === 0)
    || ((requestedRunIDs.length > 0 || sessionRef) && runIDs.length === 0);
  const kinds = stringParams(params, "kind");
  if (kinds.some((kind) => !EVIDENCE_KIND_PATTERN.test(kind))) {
    throw evidenceError(400, "invalid_kind", "Evidence kind is invalid");
  }
  const statuses = stringParams(params, "status");
  if (statuses.some((status) => !EVIDENCE_STATUSES.includes(status as typeof EVIDENCE_STATUSES[number]))) {
    throw evidenceError(400, "invalid_status", "Evidence status is invalid");
  }
  const cursor = optionalText(params.get("cursor"));
  return {
    ...(cursor ? { before_event_id: decodeCursor(cursor) } : {}),
    cursor,
    ...(issueSets.length > 0 ? { issue_ids: issueIDs } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    limit: boundedLimit(params.get("limit")),
    ...(matchNone ? { match_none: true } : {}),
    ...(projectID ? { project_id: projectID } : {}),
    ...(requestedRunIDs.length > 0 || sessionRef ? { run_ids: runIDs } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(workID ? { work_id: workID } : {})
  };
}

export function issueIDFromWorkID(workID: string): number | null {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  return match ? Number(match[1]) : null;
}

export function intersect(sets: number[][]): number[] {
  if (sets.length === 0) return [];
  return sets.slice(1).reduce(
    (current, values) => current.filter((value) => values.includes(value)),
    [...new Set(sets[0])]
  );
}

export function intersectStrings(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  return sets.slice(1).reduce(
    (current, values) => current.filter((value) => values.includes(value)),
    [...new Set(sets[0])]
  );
}

export function stringParams(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function boundedLimit(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw evidenceError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw evidenceError(400, `invalid_${name}`, `${name} must be a positive integer`);
  }
  return parsed;
}

export function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^evidence:([1-9][0-9]*)$/.exec(decoded);
    if (!match) throw new Error("invalid");
    return Number(match[1]);
  } catch {
    throw evidenceError(400, "invalid_cursor", "Evidence cursor is invalid");
  }
}

export function boundedText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function evidenceTime(evidence: EvidenceRecord): string {
  return evidence.completed_at || evidence.observed_at || evidence.created_at;
}

export function optionalText(value: string | null): string {
  return value?.trim() ?? "";
}

export class EvidenceHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function evidenceError(status: number, code: string, message: string): EvidenceHttpError {
  return new EvidenceHttpError(status, code, message);
}

export async function evidenceResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const value = await read();
    return value instanceof Response ? value : json(value);
  } catch (error) {
    if (error instanceof EvidenceHttpError) {
      return json({ code: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
}
