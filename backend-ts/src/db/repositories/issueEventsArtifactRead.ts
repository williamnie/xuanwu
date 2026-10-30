import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import { createContextBundle } from "./contextBundles.ts";
import { upsertAttentionInboxItemByEvidence } from "./attentionInboxItemUpsert.ts";
import { createIntakeRun } from "./intakeRuns.ts";
import {
  type IssueLogArtifactRef,
  ISSUE_LOG_ARTIFACT_SCHEMA,
  safeArtifactRef,
  sha256Text,
  positiveArtifactBytes,
  ISSUE_LOG_ARTIFACT_ROOT,
  jsonObject,
  ISSUE_LOG_ARTIFACT_ATTENTION_SOURCE
} from "./issueEventsModel.ts";

export function hydrateStoredIssueLogPayload(
  db: RunnerDatabase,
  storedPayload: string
): string {
  if (!hasIssueLogArtifactMarker(storedPayload)) return storedPayload;
  try {
    return hydrateStoredIssueLogPayloadStrict(db, storedPayload);
  } catch (error) {
    try {
      recordIssueLogArtifactAttention(db, storedPayload, error);
    } catch (attentionError) {
      throw new AggregateError(
        [error, attentionError],
        "issue.log artifact integrity failure; Attention write failed"
      );
    }
    throw error;
  }
}

export function hydrateStoredIssueLogPayloadStrict(
  db: Pick<RunnerDatabase, "path">,
  storedPayload: string
): string {
  const artifact = issueLogArtifactRef(storedPayload);
  if (!artifact) throw new Error("stored issue.log payload does not reference an artifact");
  const compressed = readFileSync(issueLogArtifactPath(db, artifact.ref));
  const raw = validateIssueLogArtifactBytes(artifact, compressed);
  const payload = raw.toString("utf8");
  JSON.parse(payload);
  return payload;
}

export function validateIssueLogArtifactBytes(artifact: IssueLogArtifactRef, compressed: Buffer): Buffer {
  if (compressed.byteLength !== artifact.stored_bytes) throw new Error("issue.log artifact stored byte count mismatch");
  const raw = gunzipSync(compressed);
  validateIssueLogArtifactRaw(artifact, raw);
  return raw;
}

export function validateIssueLogArtifactRaw(artifact: IssueLogArtifactRef, raw: Buffer): void {
  if (raw.byteLength !== artifact.bytes) throw new Error("issue.log artifact byte count mismatch");
  if (createHash("sha256").update(raw).digest("hex") !== artifact.sha256) {
    throw new Error("issue.log artifact checksum mismatch");
  }
}

export function hydratedIssueLogPayload(db: RunnerDatabase, storedPayload: string): string {
  return hydrateStoredIssueLogPayload(db, storedPayload);
}

export function issueLogArtifactRef(payload: string): IssueLogArtifactRef | undefined {
  try {
    const body = JSON.parse(payload) as Record<string, unknown>;
    const value = body.issue_log_artifact;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const artifact = value as Record<string, unknown>;
    if (artifact.schema_version !== ISSUE_LOG_ARTIFACT_SCHEMA || artifact.encoding !== "gzip+json") return undefined;
    if (!safeArtifactRef(artifact.ref) || !sha256Text(artifact.sha256)) return undefined;
    if (!positiveArtifactBytes(artifact.bytes) || !positiveArtifactBytes(artifact.stored_bytes)) return undefined;
    const expectedRef = `${ISSUE_LOG_ARTIFACT_ROOT}/${artifact.sha256.slice(0, 2)}/${artifact.sha256}.json.gz`;
    if (artifact.ref !== expectedRef) return undefined;
    return {
      bytes: artifact.bytes,
      encoding: "gzip+json",
      ref: artifact.ref,
      schema_version: ISSUE_LOG_ARTIFACT_SCHEMA,
      sha256: artifact.sha256,
      stored_bytes: artifact.stored_bytes
    };
  } catch {
    return undefined;
  }
}

function hasIssueLogArtifactMarker(payload: string): boolean {
  const body = jsonObject(payload);
  return Boolean(body && Object.prototype.hasOwnProperty.call(body, "issue_log_artifact"));
}

function recordIssueLogArtifactAttention(db: RunnerDatabase, storedPayload: string, error: unknown): void {
  const body = jsonObject(storedPayload) ?? {};
  const candidate = body.issue_log_artifact && typeof body.issue_log_artifact === "object" && !Array.isArray(body.issue_log_artifact)
    ? body.issue_log_artifact as Record<string, unknown>
    : {};
  const rows = db.sqlite.query<{ created_at: string; id: number; issue_id: number }, [string]>(`
    select id, issue_id, created_at from issue_events where type='issue.log' and payload=? order by id
  `).all(storedPayload);
  for (const row of rows) {
    const evidenceRef = `issue_event:${row.id}:issue_log_artifact`;
    const existing = db.sqlite.query<{ id: number }, [string, string]>(`
      select id from attention_inbox_items where source=? and evidence_refs_json=? limit 1
    `).get(ISSUE_LOG_ARTIFACT_ATTENTION_SOURCE, JSON.stringify([evidenceRef]));
    if (existing) continue;
    db.transaction(() => {
      const bundle = createContextBundle(db, {
        created_by: "system",
        event_refs: [row.id],
        evidence_refs: [evidenceRef],
        reason: "issue_log_artifact_integrity_failed",
        source: ISSUE_LOG_ARTIFACT_ATTENTION_SOURCE,
        source_query: { issue_event_id: row.id, issue_id: row.issue_id },
        trigger: "continuous",
        window: { from: row.created_at, to: row.created_at }
      });
      const intake = createIntakeRun(db, {
        bundle_id: bundle.id,
        input_summary: { issue_event_id: row.id, issue_id: row.issue_id },
        schema_output: { route: "attention" },
        skill_id: "issue-log-artifact-integrity",
        status: "succeeded"
      });
      upsertAttentionInboxItemByEvidence(db, {
        bundle_id: bundle.id,
        confidence: 1,
        evidence_refs: [evidenceRef],
        intake_run_id: intake.id,
        primary_intent: "artifact_integrity_failure",
        schema_item: {
          error: error instanceof Error ? error.message : String(error),
          issue_event_id: row.id,
          issue_id: row.issue_id,
          ref: typeof candidate.ref === "string" ? candidate.ref : "invalid",
          sha256: typeof candidate.sha256 === "string" ? candidate.sha256 : "invalid",
          type: "issue_log_artifact_integrity_failure"
        },
        source: ISSUE_LOG_ARTIFACT_ATTENTION_SOURCE,
        suggested_actions: ["restore_artifact_from_verified_backup", "verify_sha256_before_retry"],
        summary: `Issue event ${row.id} artifact is missing, malformed, or corrupt; legacy hydration stopped fail closed.`,
        target_hints: [{ issue_id: row.issue_id, issue_event_id: row.id }],
        title: `Issue log artifact integrity failure #${row.id}`,
        urgency: "high"
      });
    }).immediate();
  }
}

export function issueLogArtifactPath(db: Pick<RunnerDatabase, "path">, ref: string): string {
  if (!safeArtifactRef(ref)) throw new Error("invalid issue.log artifact ref");
  const root = resolve(dirname(db.path), ISSUE_LOG_ARTIFACT_ROOT);
  const path = resolve(dirname(db.path), ref);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("issue.log artifact ref escapes state directory");
  return path;
}
