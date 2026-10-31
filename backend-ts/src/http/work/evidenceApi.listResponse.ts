import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { getStoredEvidence, listStoredEvidence } from "../../db/repositories/evidence.ts";
import { type EvidenceArtifactRef, type EvidenceRecord } from "../../domain/evidence/contracts.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { parsedFilter, evidenceTime, EVIDENCE_HTTP_COMPATIBILITY_POLICY, evidenceError, boundedText, SUMMARY_LIMIT } from "./evidenceApi.parsedFilter.ts";
import type { ApiEvidenceRecord } from "./evidenceApi.model.ts";

export async function listResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const filter = parsedFilter(db, request);
  const page = listStoredEvidence(db, filter);
  const items: ApiEvidenceRecord[] = [...page.items]
    .sort((left, right) => evidenceTime(right.evidence).localeCompare(evidenceTime(left.evidence)))
    .slice(0, filter.limit);
  return {
    compatibility: {
      ...EVIDENCE_HTTP_COMPATIBILITY_POLICY,
      fallback_applied: false,
      fallback_sources: []
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
    projection_errors: [],
    skipped_invalid: page.skipped_invalid
  };
}

export async function detailResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const evidenceID = evidenceIDFromRequest(request);
  const stored = getStoredEvidence(db, evidenceID);
  const record = stored;
  if (!record) throw evidenceError(404, "evidence_not_found", "Evidence not found");
  return evidenceDetail(db, record);
}

export function evidenceSummary(item: ApiEvidenceRecord): Record<string, unknown> {
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

export function evidenceDetail(db: RunnerDatabase, item: ApiEvidenceRecord): Record<string, unknown> {
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
    storage_source: item.storage_source
  };
}

export function artifactAvailability(
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

export function localArtifactPath(db: RunnerDatabase, ref: string): string | null {
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

export function evidenceIDFromRequest(request: Request): string {
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

export function artifactIndex(request: Request): number {
  const parts = pathParts(request);
  const value = parts[parts.indexOf("artifacts") + 1] ?? "";
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw evidenceError(400, "invalid_artifact_index", "Artifact index is invalid");
  }
  return index;
}

export function encodeCursor(eventID: number): string {
  return Buffer.from(`evidence:${eventID}`, "utf8").toString("base64url");
}

export function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

export function safeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (sanitized || "evidence-artifact").slice(0, 120);
}

export function safeMediaType(value: string | undefined): string {
  const mediaType = value?.trim() ?? "";
  return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;\s*charset=[A-Za-z0-9._-]+)?$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}
