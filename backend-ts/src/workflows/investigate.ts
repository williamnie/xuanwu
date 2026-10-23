import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type {
  WorkflowManifestRegistration
} from "./registry.ts";

const INVESTIGATE_WORKFLOW_SOURCE_PATH = "builtin:workflows/investigate@1" as const;
const INVESTIGATE_READ_ONLY_POLICY_REF = "workflow-policy:investigate-read-only@1" as const;
const INVESTIGATE_HANDOFF_REPORT_SCHEMA_VERSION = "xw.investigate-handoff-report.v1" as const;
export const INVESTIGATE_STAGE_IDS = ["scope", "reproduce", "root-cause", "report"] as const;
type InvestigateStageID = typeof INVESTIGATE_STAGE_IDS[number];

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

const INVESTIGATE_HANDOFF_REPORT_SCHEMA = Type.Object({
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
