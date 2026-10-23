import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import type { PiRecoveryBudgetDecision } from "../pi/recoveryBudget.ts";
import {
  type RecoveryDiagnosisClassification
} from "../pi/recoveryDiagnosis.ts";
import {
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

const REPAIR_WORKFLOW_SOURCE_PATH = "builtin:workflows/repair@1" as const;
const REPAIR_STAGE_IDS = [
  "diagnose",
  "recovery-budget",
  "recover",
  "verify",
  "handoff-replan"
] as const;
export const REPAIR_RECOVERY_ACTIONS = [
  "issue.retry",
  "issue.retry_after",
  "session.resume_followup",
  "needs_user.escalate"
] as const;
type RepairStageID = typeof REPAIR_STAGE_IDS[number];

const REPAIR_DIAGNOSIS_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:repair-diagnosis",
  revision: 1,
  name: "Repair deterministic failure diagnosis",
  kind_rules: [],
  required_groups: [{
    id: "failure-diagnosis",
    operator: "all",
    requirements: [{
      id: "trusted-diagnosis",
      evidence_kinds: ["shell", "test", "http", "browser"],
      scope: "work",
      fact_assertions: [{ key: "diagnosis_code", operator: "truthy" }],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

const REPAIR_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:repair-recovery-verification",
  revision: 1,
  name: "Repair recovery verification",
  kind_rules: [],
  required_groups: [{
    id: "recovery-verification",
    operator: "all",
    requirements: [{
      id: "passed-recovery-observation",
      evidence_kinds: ["shell", "test", "lint", "build", "http", "browser"],
      scope: "work",
      fact_assertions: [{ key: "outcome", operator: "equals", expected: "passed" }],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

const REPAIR_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:repair",
  revision: 1,
  name: "Repair",
  description: "Diagnose a failure, apply the existing deterministic recovery budget and Guardian action gate, verify progress, then continue the Handoff or produce an audited replan.",
  stages: [
    readStage("diagnose", "Classify the failure from trusted Evidence", REPAIR_DIAGNOSIS_POLICY.id),
    readStage("recovery-budget", "Read the canonical recovery budget", REPAIR_DIAGNOSIS_POLICY.id),
    {
      id: "recover",
      name: "Execute one authorized recovery action",
      agent: { role: "executor", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [],
        allowed_actions: [
          "issue.retry",
          "issue.retry_after",
          "session.resume_followup"
        ]
      },
      verification_policy_ref: `${REPAIR_DIAGNOSIS_POLICY.id}@${REPAIR_DIAGNOSIS_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:guardian-recovery-action@1"
      },
      handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
    },
    readStage("verify", "Verify recovery progress with fresh Evidence", REPAIR_VERIFICATION_POLICY.id, "executor"),
    {
      id: "handoff-replan",
      name: "Continue the Handoff or emit an audited replan",
      agent: { role: "reporter", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [
          "runner-builtin:work_read",
          "runner-builtin:run_read",
        ],
        allowed_actions: ["needs_user.escalate"]
      },
      verification_policy_ref: `${REPAIR_DIAGNOSIS_POLICY.id}@${REPAIR_DIAGNOSIS_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:repair-handoff-replan@1"
      },
      handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
    }
  ]
};

export function repairWorkflowRegistryContributions(): {
  manifests: WorkflowManifestRegistration[];
  verification_policies: WorkflowVerificationPolicy[];
} {
  return {
    manifests: [{
      manifest: structuredClone(REPAIR_WORKFLOW_MANIFEST),
      source_path: REPAIR_WORKFLOW_SOURCE_PATH
    }],
    verification_policies: [
      structuredClone(REPAIR_DIAGNOSIS_POLICY),
      structuredClone(REPAIR_VERIFICATION_POLICY)
    ]
  };
}

function readStage(
  id: Extract<RepairStageID, "diagnose" | "recovery-budget" | "verify">,
  name: string,
  policyID: string,
  role: "reporter" | "executor" = "reporter"
): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role, required_skill_ids: [] },
    permissions: {
      max_tool_permission: "read",
      allowed_tools: [
        "runner-builtin:work_read",
        "runner-builtin:run_read",
        "runner-builtin:issue_read",
        "runner-builtin:issue_execution_status",
        "runner-builtin:session_read_summary"
      ],
      allowed_actions: []
    },
    verification_policy_ref: `${policyID}@1`,
    retry: { max_attempts: 1, backoff_seconds: [] },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
  };
}
