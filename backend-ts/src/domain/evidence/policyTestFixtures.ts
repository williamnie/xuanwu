import { resolve } from "node:path";

import { makeDomainID, type EvidenceID, type RunID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceAssertionOrigin,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceKind
} from "./contracts.ts";
import {
  VERIFICATION_POLICY_SCHEMA_VERSION,
  VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION,
  evaluateWorkflowVerificationPolicy,
  type EvidenceRequirement,
  type ProjectVerificationOverride,
  type VerificationRiskLevel,
  type WorkflowVerificationPolicy
} from "./policy.ts";

export const WORK_ID = makeDomainID("work", "issues", 668);

export const OTHER_WORK_ID = makeDomainID("work", "issues", 999);

export const RUN_ID = makeDomainID("run", "issue_runs", 77);

export const ATTEMPT_ID = `${RUN_ID}~attempt:1` as const;

export const NOW = "2026-07-16T10:00:00.000Z";

export const ADR_PATH = resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0032-workflow-verification-policy.md");

export let evidenceSequence = 0;

export function evaluate(
  value: WorkflowVerificationPolicy,
  evidence: EvidenceRecord[],
  overrides: Partial<Parameters<typeof evaluateWorkflowVerificationPolicy>[0]> = {}
) {
  return evaluateWorkflowVerificationPolicy({
    policy: value,
    evidence,
    context: context(),
    ...overrides
  });
}

export function policy(overrides: Partial<WorkflowVerificationPolicy> = {}): WorkflowVerificationPolicy {
  return {
    schema_version: VERIFICATION_POLICY_SCHEMA_VERSION,
    id: "verification-policy:engineering-default",
    revision: 1,
    name: "Engineering default",
    kind_rules: [],
    required_groups: [group("automated", "all", [requirement("test", ["test"])])],
    optional_requirements: [],
    risk_overrides: [],
    ...overrides
  };
}

export function group(
  id: string,
  operator: "all" | "any",
  requirements: EvidenceRequirement[]
) {
  return { id, operator, requirements };
}

export function requirement(id: string, evidenceKinds: EvidenceKind[]): EvidenceRequirement {
  return {
    id,
    evidence_kinds: evidenceKinds,
    scope: "work",
    fact_assertions: [],
    artifact_policy: "ignore"
  };
}

export function context(overrides: Partial<{
  attempt_id: typeof ATTEMPT_ID;
  now: string;
  project_id: string;
  risk: VerificationRiskLevel;
  run_id: RunID;
  work_id: WorkID;
}> = {}) {
  return {
    work_id: WORK_ID,
    project_id: "xuanwu",
    risk: "safe" as const,
    now: NOW,
    run_id: RUN_ID,
    attempt_id: ATTEMPT_ID,
    ...overrides
  };
}

export function projectOverride(
  base: WorkflowVerificationPolicy,
  overrides: Partial<ProjectVerificationOverride> = {}
): ProjectVerificationOverride {
  return {
    schema_version: VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION,
    project_id: "xuanwu",
    policy_id: base.id,
    base_policy_revision: base.revision,
    additional_required_groups: [],
    promote_optional_requirement_ids: [],
    disallow_skip_requirement_ids: [],
    deny_manual_override: false,
    audit_event_ref: "audit:project-settings:verification-policy",
    ...overrides
  };
}

export type RecordOverrides = {
  artifact_refs?: EvidenceRecord["artifact_refs"];
  assertion_origin?: EvidenceAssertionOrigin;
  attempt_id?: typeof ATTEMPT_ID;
  facts?: EvidenceRecord["decisive_output"]["facts"];
  id?: EvidenceID;
  observed_at?: string;
  producer_kind?: EvidenceRecord["provenance"]["producer"]["kind"];
  run_id?: RunID;
  source_kind?: EvidenceSourceKind;
  work_id?: WorkID;
};

export function record(
  kind: EvidenceKind,
  status: EvidenceRecord["status"],
  overrides: RecordOverrides = {}
): EvidenceRecord {
  const observedAt = overrides.observed_at ?? "2026-07-16T09:59:00.000Z";
  const sourceKind = overrides.source_kind ?? sourceKindFor(kind);
  const assertionOrigin = overrides.assertion_origin ?? (kind === "human" ? "human_attestation" : "tool_result");
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: overrides.id ?? evidenceID(`${kind}-${status}-${++evidenceSequence}`),
    work_id: overrides.work_id ?? WORK_ID,
    ...(overrides.run_id ? { run_id: overrides.run_id } : {}),
    ...(overrides.attempt_id ? { attempt_id: overrides.attempt_id } : {}),
    revision: 0,
    kind,
    status,
    created_at: observedAt,
    observed_at: observedAt,
    updated_at: observedAt,
    ...(status === "pending" ? {} : { completed_at: observedAt }),
    decisive_output: {
      summary: `${kind} ${status}`,
      facts: overrides.facts ?? { outcome: status }
    },
    artifact_refs: overrides.artifact_refs ?? [],
    provenance: {
      assertion_origin: assertionOrigin,
      source_kind: sourceKind,
      source_ref: `source:${kind}`,
      audit_event_ref: `audit:${kind}:${status}`,
      producer: {
        id: kind === "human" ? "user:reviewer" : "runner:verification",
        kind: overrides.producer_kind ?? (kind === "human" ? "user" : "runner")
      }
    },
    redaction: { status: "not_required", policy_ref: "evidence-redaction:v1", redacted_paths: [] }
  };
}

export function humanDecision(decision: string, facts: Record<string, string | number | boolean | null>): EvidenceRecord {
  return record("human", "passed", { facts: { decision, ...facts } });
}

export function sourceKindFor(kind: EvidenceKind): EvidenceSourceKind {
  if (kind === "test") return "test_runner";
  if (kind === "lint") return "linter";
  if (kind === "build") return "build_system";
  if (kind === "git") return "git_repository";
  if (kind === "http") return "http_exchange";
  if (kind === "browser") return "browser_session";
  if (kind === "human") return "human_attestation";
  return "command_execution";
}

export function evidenceID(localID: string): EvidenceID {
  return makeDomainID("evidence", "issue_events", localID);
}
