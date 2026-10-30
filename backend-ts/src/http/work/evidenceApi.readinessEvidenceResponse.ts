import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getIssue } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { EVIDENCE_RECORDED_EVENT_TYPE, getStoredEvidence, recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import { type EvidenceRecord } from "../../domain/evidence/contracts.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import type { Router } from "../router.ts";
import { validateReadinessEvidence } from "../../domain/readiness/contracts.ts";
import { startProjectLoop } from "../../runner/projectLoopManager.ts";
import { evidenceResponse, evidenceError, positiveInteger } from "./evidenceApi.parsedFilter.ts";
import { listResponse, detailResponse, evidenceIDFromRequest, artifactIndex, artifactAvailability, safeFilename, safeMediaType, pathParts } from "./evidenceApi.listResponse.ts";

export function registerEvidenceRoutes(router: Router, context: ReadApiContext): void {
  const readDatabase = context.readDatabase ?? context.database;
  router.get("/api/evidence", (request) => evidenceResponse(() => listResponse(readDatabase, request)));
  router.get("/api/evidence/:id", (request) => evidenceResponse(() => detailResponse(readDatabase, request)));
  router.get("/api/evidence/:id/artifacts/:index", (request) => (
    evidenceResponse(() => artifactResponse(readDatabase, request))
  ));
  router.post("/api/issues/:id/evidence/readiness", (request) => (
    evidenceResponse(() => readinessEvidenceResponse(context, request))
  ));
}

export async function readinessEvidenceResponse(context: ReadApiContext, request: Request): Promise<Record<string, unknown>> {
  const issueID = issueIDFromCaptureRequest(request);
  const issue = getIssue(context.database, issueID);
  if (!issue) throw evidenceError(404, "issue_not_found", "Issue not found");
  const body = await objectBody(request);
  assertKeys(body, ["evidence"]);
  const evidence = body.evidence as EvidenceRecord;
  const errors = validateReadinessEvidence(evidence);
  if (errors.length > 0) throw evidenceError(400, "invalid_readiness_evidence", errors.join("; "));
  const replayed = (context.database.sqlite.query<{ count: number }, [string, string]>(`
    select count(*) as count from issue_events where type=? and json_valid(payload)
      and json_extract(payload, '$.evidence.id')=?
  `).get(EVIDENCE_RECORDED_EVENT_TYPE, evidence.id)?.count ?? 0) > 0;
  try {
    recordEvidenceRecords(context.database, issueID, [evidence], {
      recorded_at: evidence.observed_at,
      source: "readiness-http-api"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw evidenceError(/conflicts with the append-only/i.test(message) ? 409 : 400, "invalid_readiness_evidence", message);
  }
  const project = getProject(context.database, issue.project_id);
  if (project?.auto_run === 1) {
    startProjectLoop({ bus: context.bus, database: context.database, providers: context.providers }, project.id);
  }
  return { evidence, replayed };
}

export async function artifactResponse(db: RunnerDatabase, request: Request): Promise<Response> {
  const evidenceID = evidenceIDFromRequest(request);
  const stored = getStoredEvidence(db, evidenceID);
  const record = stored;
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

export function issueIDFromCaptureRequest(request: Request): number {
  const parts = pathParts(request);
  const value = parts[parts.indexOf("issues") + 1] ?? "";
  return positiveInteger(value, "issue_id");
}

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw evidenceError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceError(400, "invalid_body", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw evidenceError(400, "unknown_fields", `Unknown fields: ${unknown.join(", ")}`);
  }
}
