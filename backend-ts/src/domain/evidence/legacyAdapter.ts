import type { VerificationEvidenceV0 } from "../../pi/verificationEvidence.ts";
import type { DomainActor, EvidenceID, RunID, WorkID } from "../../xuanwu/coreDomainContracts.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  type EvidenceArtifactKind,
  type EvidenceKind,
  type EvidenceRecord
} from "./contracts.ts";

export type LegacyVerificationEvidenceProjectionContext = {
  audit_event_ref: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  projected_at: string;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

const LEGACY_KIND_MAP: Record<VerificationEvidenceV0["kind"], EvidenceKind> = {
  shell_test: "shell",
  http_smoke: "http",
  human_verification: "human",
  // V0 does not say whether the checker is deterministic, another agent, or a human.
  independent_checker: "legacy.independent_checker"
};

export function projectVerificationEvidenceV0(
  legacy: VerificationEvidenceV0,
  context: LegacyVerificationEvidenceProjectionContext
): EvidenceRecord {
  const facts: EvidenceRecord["decisive_output"]["facts"] = {
    legacy_schema_version: legacy.version
  };
  if (legacy.command) facts.command = legacy.command;
  if (legacy.url) facts.url = legacy.url;
  if (legacy.checker) facts.checker = legacy.checker;
  if (legacy.blocking_issues?.length) facts.blocking_issues = legacy.blocking_issues.join("; ");

  const evidence: EvidenceRecord = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: context.evidence_id,
    work_id: context.work_id,
    ...(context.run_id ? { run_id: context.run_id } : {}),
    revision: 0,
    kind: LEGACY_KIND_MAP[legacy.kind],
    status: legacy.status,
    created_at: legacy.created_at,
    observed_at: legacy.created_at,
    updated_at: context.projected_at,
    ...(legacy.status === "pending" ? {} : { completed_at: legacy.created_at }),
    decisive_output: {
      summary: legacy.summary,
      facts
    },
    artifact_refs: uniqueStrings(legacy.artifact_refs).map((ref) => ({
      kind: legacyArtifactKind(ref),
      ref
    })),
    provenance: {
      assertion_origin: "legacy_import",
      source_kind: "legacy_verification",
      source_ref: context.source_ref,
      audit_event_ref: context.audit_event_ref,
      producer: context.producer
    },
    redaction: {
      status: "not_required",
      policy_ref: "verification-evidence-v0-normalization",
      redacted_paths: []
    }
  };
  return redactEvidenceRecord(evidence, "evidence-redaction:v1");
}

function legacyArtifactKind(ref: string): EvidenceArtifactKind {
  const prefix = ref.split(":", 1)[0]?.toLowerCase();
  switch (prefix) {
    case "log": return "log";
    case "report": return "report";
    case "screenshot": return "screenshot";
    case "trace": return "trace";
    case "diff": return "diff";
    case "commit": return "commit";
    case "url": return "url";
    case "file": return "file";
    default: return "other";
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
