import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { getIssue } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  getStoredEvidence,
  issueIDForEvidenceSourceEvent,
  issueIDsForRun,
  issueIDsForSession,
  listStoredEvidence,
  runIDsForSession,
  type StoredEvidenceRecord
} from "../db/repositories/evidence.ts";
import { projectIssueRuntimeEvidence } from "../domain/evidence/completionGate.ts";
import {
  EVIDENCE_STATUSES,
  type EvidenceArtifactRef,
  type EvidenceRecord
} from "../domain/evidence/contracts.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";
import { parseStructuredVerifierReviewEventPayload } from "../domain/evidence/verifierReview.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUMMARY_LIMIT = 320;
const EVIDENCE_KIND_PATTERN = /^[a-z][a-z0-9_.-]*$/;

export const EVIDENCE_HTTP_COMPATIBILITY_POLICY = {
  artifact_authority: "content-addressed-collector-artifacts-with-authenticated-download",
  dual_read: "W2-structured-primary-with-targeted-W1-projection-fallback-for-at-most-two-release-windows",
  dual_write: "none-raw-authority-and-structured-projection-have-distinct-responsibilities",
  fact_authority: "originating-command-git-http-browser-or-human-authority",
  final_removal_gate: "P11.03/P11.06-and-G7-and-zero-legacy-consumer-for-one-release-and-artifact-restore-rehearsal",
  read_authority: "issue_events:evidence.recorded.v1",
  rollback: "unregister-evidence-routes-and-stop-new-structured-projection-without-deleting-events-or-artifacts"
} as const;

type ApiEvidenceRecord = StoredEvidenceRecord | {
  evidence: EvidenceRecord;
  event_id: number;
  issue_id: number;
  project_id: string;
  storage_source: "compatibility_projection";
};

type ParsedFilter = {
  before_event_id?: number;
  cursor: string;
  issue_ids?: number[];
  kinds?: string[];
  limit: number;
  match_none?: boolean;
  project_id?: string;
  run_ids?: string[];
  statuses?: string[];
  work_id?: string;
};

export function registerEvidenceRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/evidence", (request) => evidenceResponse(() => listResponse(context.database, request)));
  router.get("/api/evidence/:id", (request) => evidenceResponse(() => detailResponse(context.database, request)));
  router.get("/api/evidence/:id/artifacts/:index", (request) => (
    evidenceResponse(() => artifactResponse(context.database, request))
  ));
}

async function listResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const filter = parsedFilter(db, request);
  const page = listStoredEvidence(db, filter);
  const projected = filter.cursor === "" && !filter.match_none
    ? await compatibilityProjection(db, filter, page.items)
    : { errors: [] as string[], items: [] as ApiEvidenceRecord[] };
  const items: ApiEvidenceRecord[] = [...page.items, ...projected.items]
    .sort((left, right) => evidenceTime(right.evidence).localeCompare(evidenceTime(left.evidence)))
    .slice(0, filter.limit);
  const fallbackSources = new Set(items.map((item) => item.storage_source).filter((source) => source !== "structured"));
  return {
    compatibility: {
      ...EVIDENCE_HTTP_COMPATIBILITY_POLICY,
      fallback_applied: fallbackSources.size > 0,
      fallback_sources: [...fallbackSources]
    },
    filters: {
      issue_ids: filter.issue_ids ?? [],
      kind: filter.kinds ?? [],
      project_id: filter.project_id ?? "",
      run_ids: filter.run_ids ?? [],
      status: filter.statuses ?? [],
      work_id: filter.work_id ?? ""
    },
    has_more: page.has_more,
    items: items.map(evidenceSummary),
    limit: filter.limit,
    next_cursor: page.next_before_event_id ? encodeCursor(page.next_before_event_id) : "",
    projection_errors: projected.errors,
    skipped_invalid: page.skipped_invalid
  };
}

async function detailResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const evidenceID = evidenceIDFromRequest(request);
  const stored = getStoredEvidence(db, evidenceID);
  const record = stored ?? await projectedEvidence(db, evidenceID);
  if (!record) throw evidenceError(404, "evidence_not_found", "Evidence not found");
  return evidenceDetail(db, record);
}

async function artifactResponse(db: RunnerDatabase, request: Request): Promise<Response> {
  const evidenceID = evidenceIDFromRequest(request);
  const stored = getStoredEvidence(db, evidenceID);
  const record = stored ?? await projectedEvidence(db, evidenceID);
  if (!record) throw evidenceError(404, "evidence_not_found", "Evidence not found");
  const index = artifactIndex(request);
  const artifact = record.evidence.artifact_refs[index];
  if (!artifact) throw evidenceError(404, "artifact_not_found", "Evidence artifact not found");
  const availability = artifactAvailability(db, record.evidence, artifact);
  if (!availability.downloadable || !availability.path) {
    const status = availability.reason === "expired" || availability.reason === "missing" ? 410 : 409;
    throw evidenceError(status, "artifact_unavailable", `Evidence artifact is unavailable: ${availability.reason}`);
  }
  const bytes = readFileSync(availability.path);
  if (!artifact.sha256 || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw evidenceError(409, "artifact_integrity_failed", "Evidence artifact digest does not match its reference");
  }
  const filename = safeFilename(artifact.label || basename(availability.path));
  return new Response(bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.byteLength),
      "content-type": safeMediaType(artifact.media_type)
    }
  });
}

function parsedFilter(db: RunnerDatabase, request: Request): ParsedFilter {
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

async function compatibilityProjection(
  db: RunnerDatabase,
  filter: ParsedFilter,
  stored: readonly StoredEvidenceRecord[]
): Promise<{ errors: string[]; items: ApiEvidenceRecord[] }> {
  const issueIDs = filter.issue_ids ?? [];
  if (issueIDs.length === 0 || issueIDs.length > 10) return { errors: [], items: [] };
  const seen = new Set(stored.map((item) => item.evidence.id));
  const errors: string[] = [];
  const items: ApiEvidenceRecord[] = [];
  for (const issueID of issueIDs) {
    const issue = getIssue(db, issueID);
    if (!issue) continue;
    if (filter.project_id && issue.project_id !== filter.project_id) continue;
    const projection = await projectIssueRuntimeEvidence(db, issueID);
    errors.push(...projection.errors.map((error) => `Issue ${issueID}: ${error}`));
    for (const evidence of projection.evidence) {
      if (seen.has(evidence.id) || !matchesFilter(evidence, filter)) continue;
      seen.add(evidence.id);
      items.push({
        evidence,
        event_id: sourceEventID(evidence.id) ?? 0,
        issue_id: issueID,
        project_id: issue.project_id,
        storage_source: "compatibility_projection"
      });
    }
  }
  return { errors, items };
}

async function projectedEvidence(db: RunnerDatabase, evidenceID: string): Promise<ApiEvidenceRecord | null> {
  const eventID = sourceEventID(evidenceID);
  if (!eventID) return null;
  const issueID = issueIDForEvidenceSourceEvent(db, eventID);
  if (!issueID) return null;
  const issue = getIssue(db, issueID);
  if (!issue) return null;
  const projection = await projectIssueRuntimeEvidence(db, issueID);
  const evidence = projection.evidence.find((item) => item.id === evidenceID);
  return evidence ? {
    evidence,
    event_id: eventID,
    issue_id: issueID,
    project_id: issue.project_id,
    storage_source: "compatibility_projection"
  } : null;
}

function evidenceSummary(item: ApiEvidenceRecord): Record<string, unknown> {
  const evidence = item.evidence;
  return {
    artifact_count: evidence.artifact_refs.length,
    attempt_id: evidence.attempt_id ?? "",
    completed_at: evidence.completed_at ?? "",
    decisive_summary: boundedText(evidence.decisive_output.summary, SUMMARY_LIMIT),
    exit_code: evidence.decisive_output.exit_code ?? null,
    id: evidence.id,
    issue_id: item.issue_id,
    kind: evidence.kind,
    links: {
      detail: `/api/evidence/${encodeURIComponent(evidence.id)}`,
      run: evidence.run_id ? `/api/runs/${encodeURIComponent(evidence.run_id)}` : "",
      work: `/api/works/${encodeURIComponent(evidence.work_id)}`
    },
    observed_at: evidence.observed_at,
    origin: evidence.provenance.assertion_origin,
    producer: evidence.provenance.producer,
    project_id: item.project_id,
    run_id: evidence.run_id ?? "",
    status: evidence.status,
    storage_source: item.storage_source,
    work_id: evidence.work_id
  };
}

function evidenceDetail(db: RunnerDatabase, item: ApiEvidenceRecord): Record<string, unknown> {
  return {
    artifacts: item.evidence.artifact_refs.map((artifact, index) => {
      const availability = artifactAvailability(db, item.evidence, artifact);
      return {
        ...artifact,
        download_url: availability.downloadable
          ? `/api/evidence/${encodeURIComponent(item.evidence.id)}/artifacts/${index}`
          : "",
        downloadable: availability.downloadable,
        unavailable_reason: availability.downloadable ? "" : availability.reason
      };
    }),
    compatibility: {
      ...EVIDENCE_HTTP_COMPATIBILITY_POLICY,
      fallback_applied: item.storage_source !== "structured",
      fallback_source: item.storage_source
    },
    evidence: item.evidence,
    issue_id: item.issue_id,
    project_id: item.project_id,
    storage_source: item.storage_source,
    verifier_review_refs: verifierReviewRefs(db, item.issue_id, item.evidence.id)
  };
}

function verifierReviewRefs(
  db: RunnerDatabase,
  issueID: number,
  evidenceID: string
): Array<Record<string, unknown>> {
  const events = listIssueEvents(db, issueID, { limit: 50, types: ["issue.verification_report"] });
  return events.flatMap((event) => {
    const review = parseStructuredVerifierReviewEventPayload(event.payload);
    if (!review) return [];
    const findingIDs = review.findings
      .filter((finding) => finding.evidence_ids.includes(evidenceID))
      .map((finding) => finding.finding_id);
    if (findingIDs.length === 0) return [];
    return [{
      event_id: event.id,
      finding_ids: findingIDs,
      policy_ref: review.input_context.policy_ref,
      recommended_next_action: review.recommended_next_action,
      verdict: review.verdict
    }];
  }).reverse();
}

function artifactAvailability(
  db: RunnerDatabase,
  evidence: EvidenceRecord,
  artifact: EvidenceArtifactRef
): { downloadable: boolean; path?: string; reason: string } {
  const expiresAt = evidence.decisive_output.facts.artifact_expires_at;
  if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) && Date.now() >= Date.parse(expiresAt)) {
    return { downloadable: false, reason: "expired" };
  }
  if (!artifact.sha256) return { downloadable: false, reason: "integrity_digest_missing" };
  const path = localArtifactPath(db, artifact.ref);
  if (!path) return { downloadable: false, reason: "opaque_or_external_ref" };
  if (!existsSync(path)) return { downloadable: false, reason: "missing" };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return { downloadable: false, reason: "invalid_file_type" };
  const stateRoot = realpathSync(dirname(db.path));
  const realPath = realpathSync(path);
  if (realPath !== stateRoot && !realPath.startsWith(`${stateRoot}${sep}`)) {
    return { downloadable: false, reason: "path_escape" };
  }
  return { downloadable: true, path: realPath, reason: "available" };
}

function localArtifactPath(db: RunnerDatabase, ref: string): string | null {
  const valid = [
    /^artifacts\/evidence-command-output\/[a-f0-9]{2}\/[a-f0-9]{64}\.log$/,
    /^artifacts\/evidence-http-exchange\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/,
    /^artifacts\/evidence-git-snapshot\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/,
    /^uploads\/artifacts\/evidence-browser\/[a-f0-9]{2}\/[a-f0-9]{64}\/(?:report\.json|[0-9]+-[a-f0-9]{64}\.(?:png|jpg|webp))$/
  ].some((pattern) => pattern.test(ref));
  if (!valid) return null;
  const root = resolve(dirname(db.path));
  const path = resolve(root, ref);
  return path.startsWith(`${root}${sep}`) ? path : null;
}

function matchesFilter(evidence: EvidenceRecord, filter: ParsedFilter): boolean {
  if (filter.work_id && evidence.work_id !== filter.work_id) return false;
  if (filter.run_ids && !filter.run_ids.includes(evidence.run_id ?? "")) return false;
  if (filter.kinds && !filter.kinds.includes(evidence.kind)) return false;
  if (filter.statuses && !filter.statuses.includes(evidence.status)) return false;
  return true;
}

function evidenceIDFromRequest(request: Request): string {
  const parts = pathParts(request);
  const raw = parts[parts.indexOf("evidence") + 1] ?? "";
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw).trim();
  } catch {
    throw evidenceError(400, "invalid_evidence_id", "Evidence id is invalid");
  }
  if (!decoded.startsWith("xw:evidence:")) {
    throw evidenceError(400, "invalid_evidence_id", "Evidence id is invalid");
  }
  return decoded;
}

function artifactIndex(request: Request): number {
  const parts = pathParts(request);
  const value = parts[parts.indexOf("artifacts") + 1] ?? "";
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw evidenceError(400, "invalid_artifact_index", "Artifact index is invalid");
  }
  return index;
}

function sourceEventID(evidenceID: string): number | null {
  const match = /^xw:evidence:issue_events:([1-9][0-9]*)$/.exec(evidenceID);
  return match ? Number(match[1]) : null;
}

function issueIDFromWorkID(workID: string): number | null {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  return match ? Number(match[1]) : null;
}

function intersect(sets: number[][]): number[] {
  if (sets.length === 0) return [];
  return sets.slice(1).reduce(
    (current, values) => current.filter((value) => values.includes(value)),
    [...new Set(sets[0])]
  );
}

function intersectStrings(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  return sets.slice(1).reduce(
    (current, values) => current.filter((value) => values.includes(value)),
    [...new Set(sets[0])]
  );
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
    throw evidenceError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw evidenceError(400, `invalid_${name}`, `${name} must be a positive integer`);
  }
  return parsed;
}

function encodeCursor(eventID: number): string {
  return Buffer.from(`evidence:${eventID}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^evidence:([1-9][0-9]*)$/.exec(decoded);
    if (!match) throw new Error("invalid");
    return Number(match[1]);
  } catch {
    throw evidenceError(400, "invalid_cursor", "Evidence cursor is invalid");
  }
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function evidenceTime(evidence: EvidenceRecord): string {
  return evidence.completed_at || evidence.observed_at || evidence.created_at;
}

function optionalText(value: string | null): string {
  return value?.trim() ?? "";
}

function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (sanitized || "evidence-artifact").slice(0, 120);
}

function safeMediaType(value: string | undefined): string {
  const mediaType = value?.trim() ?? "";
  return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;\s*charset=[A-Za-z0-9._-]+)?$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

class EvidenceHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function evidenceError(status: number, code: string, message: string): EvidenceHttpError {
  return new EvidenceHttpError(status, code, message);
}

async function evidenceResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
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
