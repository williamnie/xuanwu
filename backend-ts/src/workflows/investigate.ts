import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canSatisfyEvidenceGate,
  validateEvidence,
  type EvidenceRecord
} from "../domain/evidence/contracts.ts";
import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type {
  WorkflowManifestRegistration
} from "./registry.ts";

export const INVESTIGATE_WORKFLOW_SOURCE_PATH = "builtin:workflows/investigate@1" as const;
export const INVESTIGATE_READ_ONLY_POLICY_REF = "workflow-policy:investigate-read-only@1" as const;
export const INVESTIGATE_HANDOFF_REPORT_SCHEMA_VERSION = "xw.investigate-handoff-report.v1" as const;
export const INVESTIGATE_STAGE_IDS = ["scope", "reproduce", "root-cause", "report"] as const;
export type InvestigateStageID = typeof INVESTIGATE_STAGE_IDS[number];

export const INVESTIGATE_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:investigate-read-only",
  revision: 1,
  name: "Investigate read-only observation policy",
  kind_rules: [],
  required_groups: [{
    id: "investigation-observation",
    operator: "all",
    requirements: [{
      id: "audited-read-observation",
      evidence_kinds: ["shell", "test", "http", "browser"],
      scope: "work",
      fact_assertions: [],
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const INVESTIGATE_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:investigate",
  revision: 1,
  name: "Investigate",
  description: "Read-only scoping, reproduction, root-cause analysis, Evidence collection, and bounded handoff reporting.",
  stages: [
    stage("scope", "Scope the investigation", "reporter", [
      "runner-builtin:project_status",
      "runner-builtin:work_read",
      "runner-builtin:run_read",
      "runner-builtin:issue_read",
      "runner-builtin:issue_execution_status",
      "runner-builtin:session_read_summary"
    ]),
    stage("reproduce", "Reproduce without mutation", "executor", [
      "runner-builtin:read",
      "runner-builtin:grep",
      "runner-builtin:find",
      "runner-builtin:ls",
      "runner-builtin:repo_tree",
      "runner-builtin:repo_search",
      "runner-builtin:repo_read_excerpt",
      "http-readonly:url_fetch",
      "browser-readonly:read_page_context"
    ]),
    stage("root-cause", "Establish the root cause", "executor", [
      "runner-builtin:read",
      "runner-builtin:grep",
      "runner-builtin:find",
      "runner-builtin:ls",
      "runner-builtin:repo_tree",
      "runner-builtin:repo_search",
      "runner-builtin:repo_read_excerpt",
      "runner-builtin:work_read",
      "runner-builtin:run_read",
      "runner-builtin:issue_read",
      "runner-builtin:issue_execution_status",
      "runner-builtin:session_read_summary",
      "http-readonly:url_fetch",
      "browser-readonly:read_page_context"
    ]),
    stage("report", "Produce the handoff report", "reporter", [
      "runner-builtin:work_read",
      "runner-builtin:run_read",
    ])
  ]
};

export const INVESTIGATE_WORKFLOW_REF = workflowManifestRef(INVESTIGATE_WORKFLOW_MANIFEST);

const requiredText = Type.String({ minLength: 1, maxLength: 4096 });
const reference = Type.String({ minLength: 1, maxLength: 8192 });
const evidenceID = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});
const workID = Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" });
const stageID = Type.Union(INVESTIGATE_STAGE_IDS.map((id) => Type.Literal(id)));
const emptyOperationList = () => Type.Array(reference, { maxItems: 0 });

export const INVESTIGATE_HANDOFF_REPORT_SCHEMA = Type.Object({
  schema_version: Type.Literal(INVESTIGATE_HANDOFF_REPORT_SCHEMA_VERSION),
  workflow_ref: Type.Literal(INVESTIGATE_WORKFLOW_REF),
  work_id: workID,
  outcome: Type.Union([
    Type.Literal("confirmed"),
    Type.Literal("not_reproduced"),
    Type.Literal("insufficient_information")
  ]),
  summary: requiredText,
  stages: Type.Array(Type.Object({
    id: stageID,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("inconclusive"),
      Type.Literal("blocked")
    ]),
    finding: requiredText,
    evidence_ids: Type.Array(evidenceID, { maxItems: 64 })
  }, { additionalProperties: false }), { minItems: INVESTIGATE_STAGE_IDS.length, maxItems: INVESTIGATE_STAGE_IDS.length }),
  evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 256 }),
  reproduction: Type.Object({
    status: Type.Union([
      Type.Literal("reproduced"),
      Type.Literal("not_reproduced"),
      Type.Literal("insufficient_information")
    ]),
    steps: Type.Array(requiredText, { maxItems: 32 }),
    expected: requiredText,
    observed: requiredText
  }, { additionalProperties: false }),
  root_cause: Type.Object({
    status: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("hypothesis"),
      Type.Literal("unknown")
    ]),
    summary: requiredText
  }, { additionalProperties: false }),
  handoff: Type.Object({
    report_ref: reference,
    recommended_next_steps: Type.Array(requiredText, { maxItems: 32 }),
    unresolved_questions: Type.Array(requiredText, { maxItems: 32 })
  }, { additionalProperties: false }),
  read_only_audit: Type.Object({
    policy_ref: Type.Literal(INVESTIGATE_READ_ONLY_POLICY_REF),
    confirmation: Type.Literal("no_write_operations_observed"),
    tool_audit_refs: Type.Array(reference, { minItems: 1, maxItems: 256 }),
    allowed_actions: emptyOperationList(),
    changed_files: emptyOperationList(),
    state_mutations: emptyOperationList(),
    external_writes: emptyOperationList(),
    destructive_operations: emptyOperationList()
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type InvestigateHandoffReport = Static<typeof INVESTIGATE_HANDOFF_REPORT_SCHEMA>;
export type InvestigateHandoffValidation = { errors: string[]; ok: boolean };

export function investigateWorkflowRegistryContributions(): {
  manifests: WorkflowManifestRegistration[];
  verification_policies: WorkflowVerificationPolicy[];
} {
  return {
    manifests: [{
      manifest: structuredClone(INVESTIGATE_WORKFLOW_MANIFEST),
      source_path: INVESTIGATE_WORKFLOW_SOURCE_PATH
    }],
    verification_policies: [structuredClone(INVESTIGATE_VERIFICATION_POLICY)]
  };
}

export function parseInvestigateHandoffReportJSON(
  text: string,
  evidence?: readonly EvidenceRecord[]
): { ok: true; report: InvestigateHandoffReport } | { errors: string[]; ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "invalid JSON"], ok: false };
  }
  const validation = validateInvestigateHandoffReport(value, evidence);
  return validation.ok
    ? { ok: true, report: value as InvestigateHandoffReport }
    : { errors: validation.errors, ok: false };
}

export function validateInvestigateHandoffReport(
  input: unknown,
  evidence?: readonly EvidenceRecord[]
): InvestigateHandoffValidation {
  if (!Value.Check(INVESTIGATE_HANDOFF_REPORT_SCHEMA, input)) {
    return {
      errors: [...Value.Errors(INVESTIGATE_HANDOFF_REPORT_SCHEMA, input)].map((error) =>
        `schema ${error.path || "/"}: ${error.message}`
      ),
      ok: false
    };
  }
  const report = input as InvestigateHandoffReport;
  const errors: string[] = [];
  const stageIDs = report.stages.map((stage) => stage.id);
  if (stageIDs.some((id, index) => id !== INVESTIGATE_STAGE_IDS[index])) {
    errors.push(`stages must be ordered exactly as ${INVESTIGATE_STAGE_IDS.join(", ")}`);
  }
  if (new Set(report.evidence_ids).size !== report.evidence_ids.length) {
    errors.push("evidence_ids must be unique");
  }
  if (new Set(report.read_only_audit.tool_audit_refs).size !== report.read_only_audit.tool_audit_refs.length) {
    errors.push("tool_audit_refs must be unique");
  }
  const reportEvidence = new Set(report.evidence_ids);
  const stageEvidence = new Set(report.stages.flatMap((stage) => stage.evidence_ids));
  for (const id of stageEvidence) if (!reportEvidence.has(id)) errors.push(`stage references undeclared Evidence ${id}`);
  for (const id of reportEvidence) if (!stageEvidence.has(id)) errors.push(`Evidence ${id} is not linked to a stage`);
  validateOutcome(report, errors);
  if (evidence) validateLinkedEvidence(report, evidence, errors);
  return { errors, ok: errors.length === 0 };
}

function stage(
  id: InvestigateStageID,
  name: string,
  role: "reporter" | "executor",
  allowedTools: string[]
): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role, required_skill_ids: [] },
    permissions: {
      max_tool_permission: "read",
      allowed_tools: allowedTools,
      allowed_actions: []
    },
    verification_policy_ref: "verification-policy:investigate-read-only@1",
    retry: { max_attempts: 1, backoff_seconds: [] },
    approval: { mode: "none" },
    handoff: {
      mode: "local_changes",
      project_override_modes: ["local_changes"]
    }
  };
}

function validateOutcome(report: InvestigateHandoffReport, errors: string[]): void {
  const byID = new Map(report.stages.map((stage) => [stage.id, stage]));
  if (byID.get("scope")?.status !== "completed") errors.push("scope stage must be completed");
  if (byID.get("report")?.status !== "completed") errors.push("report stage must be completed");
  if (report.outcome === "confirmed") {
    if (report.reproduction.status !== "reproduced") errors.push("confirmed outcome requires reproduced status");
    if (report.root_cause.status !== "confirmed") errors.push("confirmed outcome requires confirmed root cause");
    if (byID.get("reproduce")?.status !== "completed" || byID.get("root-cause")?.status !== "completed") {
      errors.push("confirmed outcome requires completed reproduce and root-cause stages");
    }
  }
  if (report.outcome === "not_reproduced") {
    if (report.reproduction.status !== "not_reproduced") {
      errors.push("not_reproduced outcome requires not_reproduced reproduction status");
    }
    if (report.root_cause.status === "confirmed") errors.push("not_reproduced outcome cannot claim a confirmed root cause");
    if (byID.get("reproduce")?.status !== "completed") {
      errors.push("not_reproduced outcome requires a completed reproduction attempt");
    }
  }
  if (report.outcome === "insufficient_information") {
    if (report.reproduction.status !== "insufficient_information") {
      errors.push("insufficient_information outcome requires matching reproduction status");
    }
    if (report.root_cause.status !== "unknown") {
      errors.push("insufficient_information outcome requires unknown root cause");
    }
    if (byID.get("reproduce")?.status !== "blocked" || byID.get("root-cause")?.status !== "blocked") {
      errors.push("insufficient_information outcome requires blocked reproduce and root-cause stages");
    }
  }
}

function validateLinkedEvidence(
  report: InvestigateHandoffReport,
  evidence: readonly EvidenceRecord[],
  errors: string[]
): void {
  const byID = new Map(evidence.map((item) => [item.id, item]));
  for (const id of report.evidence_ids) {
    const item = byID.get(id as EvidenceRecord["id"]);
    if (!item) {
      errors.push(`linked Evidence is missing: ${id}`);
      continue;
    }
    const validation = validateEvidence(item);
    if (!validation.ok) errors.push(`linked Evidence ${id} is invalid: ${validation.errors.join("; ")}`);
    if (item.work_id !== report.work_id) errors.push(`linked Evidence ${id} belongs to another Work`);
  }
  if (!report.evidence_ids.some((id) => {
    const item = byID.get(id as EvidenceRecord["id"]);
    return item ? canSatisfyEvidenceGate(item) : false;
  })) {
    errors.push("report requires at least one passed trusted Evidence observation");
  }
}
