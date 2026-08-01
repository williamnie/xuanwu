import {
  canSatisfyEvidenceGate,
  validateEvidence,
  type EvidenceRecord,
  type WorkID
} from "../domain/evidence/contracts.ts";
import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import type { PiRecoveryBudgetDecision } from "../pi/recoveryBudget.ts";
import {
  classifyRecoveryDiagnosis,
  type RecoveryDiagnosisClassification
} from "../pi/recoveryDiagnosis.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

export const REPAIR_WORKFLOW_SOURCE_PATH = "builtin:workflows/repair@1" as const;
export const REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION = "xw.repair-workflow-projection.v1" as const;
export const REPAIR_STAGE_IDS = [
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
export type RepairStageID = typeof REPAIR_STAGE_IDS[number];
export type RepairRecoveryAction = typeof REPAIR_RECOVERY_ACTIONS[number];

export const REPAIR_DIAGNOSIS_POLICY: WorkflowVerificationPolicy = {
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

export const REPAIR_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
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

export const REPAIR_WORKFLOW_MANIFEST: WorkflowManifest = {
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

export const REPAIR_WORKFLOW_REF = workflowManifestRef(REPAIR_WORKFLOW_MANIFEST);

export type RepairWorkflowPlanInput = {
  action_candidate: Record<string, unknown>;
  allowed_actions: readonly RepairRecoveryAction[];
  budget: PiRecoveryBudgetDecision;
  diagnosis_code: string;
  diagnosis_evidence: readonly EvidenceRecord[];
  event_id: string;
  handoff_audit_event_ref: string;
  handoff_ref: string;
  issue_id: number;
  project_id: string;
  provider?: string;
  provider_error_category?: string;
  provider_session_id?: string;
  provider_turn_id?: string;
  work_id: WorkID;
};

export type RepairWorkflowPlan = {
  action_candidate: Record<string, unknown>;
  action_type: RepairRecoveryAction;
  budget: PiRecoveryBudgetDecision;
  diagnosis: RecoveryDiagnosisClassification;
  diagnosis_evidence_ids: string[];
  failure_class: "budget_exhausted" | "permanent" | "transient";
  handoff: {
    audit_event_ref: string;
    mode: "continue" | "replan";
    ref: string;
  };
  schema_version: typeof REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION;
  status: "ready";
  workflow_ref: typeof REPAIR_WORKFLOW_REF;
  work_id: WorkID;
};

export type RepairWorkflowCompletion = {
  action_audit_event_ref: string;
  action_type: RepairRecoveryAction;
  evidence_ids: string[];
  handoff: RepairWorkflowPlan["handoff"];
  outcome: "recovered" | "replan_required";
  schema_version: typeof REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION;
  workflow_ref: typeof REPAIR_WORKFLOW_REF;
  work_id: WorkID;
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

export function planRepairWorkflow(input: RepairWorkflowPlanInput): RepairWorkflowPlan {
  validatePlanInput(input);
  const observedDiagnosis = classifyRecoveryDiagnosis({
    diagnosisCode: input.diagnosis_code,
    providerErrorCategory: input.provider_error_category,
    status: "failed"
  });
  if (observedDiagnosis.failure_class === "none") {
    throw new Error("Repair requires a deterministic failure diagnosis");
  }

  const budgetExhausted = input.budget.status !== "allow";
  if (observedDiagnosis.failure_class === "exhausted" && !budgetExhausted) {
    throw new Error("exhausted Repair diagnosis requires an exhausted canonical recovery budget");
  }
  const effectiveDiagnosisCode = budgetExhausted
    ? input.budget.diagnosis_code || "recovery_budget_exhausted"
    : input.diagnosis_code;
  const effectiveDiagnosis = classifyRecoveryDiagnosis({
    diagnosisCode: effectiveDiagnosisCode,
    providerErrorCategory: input.provider_error_category,
    status: "failed"
  });
  const failureClass = budgetExhausted
    ? "budget_exhausted"
    : observedDiagnosis.failure_class === "transient" ? "transient" : "permanent";
  const mode = failureClass === "transient" ? "continue" : "replan";
  const candidate = structuredClone(input.action_candidate);
  const actionType = clean(candidate.action_type) as RepairRecoveryAction;
  if (!REPAIR_RECOVERY_ACTIONS.includes(actionType)) {
    throw new Error(`PI selected unsupported Repair action ${actionType}`);
  }
  if (!input.allowed_actions.includes(actionType)) {
    throw new Error(`PI-selected Repair action ${actionType} is outside the workflow action scope`);
  }
  if (!authorizedAction(candidate, actionType)) {
    throw new Error(`PI-selected Repair action ${actionType} is not authorized by the deterministic gate policy`);
  }
  if (failureClass === "transient" && actionType === "needs_user.escalate") {
    throw new Error("transient Repair cannot skip recovery and escalate while budget remains");
  }
  if (failureClass !== "transient" && actionType !== "needs_user.escalate") {
    throw new Error(`${failureClass} Repair must stop automatic recovery and replan`);
  }

  return {
    action_candidate: structuredClone(candidate),
    action_type: actionType,
    budget: structuredClone(input.budget),
    diagnosis: effectiveDiagnosis,
    diagnosis_evidence_ids: input.diagnosis_evidence.map((item) => item.id),
    failure_class: failureClass,
    handoff: {
      audit_event_ref: input.handoff_audit_event_ref,
      mode,
      ref: input.handoff_ref
    },
    schema_version: REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION,
    status: "ready",
    workflow_ref: REPAIR_WORKFLOW_REF,
    work_id: input.work_id
  };
}

export function completeRepairWorkflow(
  plan: RepairWorkflowPlan,
  input: {
    action_audit_event_ref: string;
    action_outcome: "succeeded";
    action_type: RepairRecoveryAction;
    verification_evidence: readonly EvidenceRecord[];
  }
): RepairWorkflowCompletion {
  validatePlanProjection(plan);
  if (input.action_type !== plan.action_type) throw new Error("Repair completion action does not match the plan");
  requiredText(input.action_audit_event_ref, "Repair action audit_event_ref");
  if (input.action_outcome !== "succeeded") throw new Error("Repair action must have an audited succeeded outcome");

  const verificationIDs: string[] = [];
  if (plan.failure_class === "transient") {
    if (input.verification_evidence.length === 0) {
      throw new Error("transient Repair completion requires fresh verification Evidence");
    }
    const diagnosisIDs = new Set(plan.diagnosis_evidence_ids);
    for (const evidence of input.verification_evidence) {
      validateTrustedEvidence(evidence, plan.work_id, "verification");
      if (diagnosisIDs.has(evidence.id)) throw new Error(`Repair verification Evidence is not fresh: ${evidence.id}`);
      if (evidence.decisive_output.facts.outcome !== "passed") {
        throw new Error(`Repair verification Evidence ${evidence.id} does not record outcome=passed`);
      }
      verificationIDs.push(evidence.id);
    }
  } else if (input.verification_evidence.length > 0) {
    throw new Error(`${plan.failure_class} Repair must replan without claiming recovery verification`);
  }

  return {
    action_audit_event_ref: input.action_audit_event_ref,
    action_type: input.action_type,
    evidence_ids: [...plan.diagnosis_evidence_ids, ...verificationIDs],
    handoff: structuredClone(plan.handoff),
    outcome: plan.failure_class === "transient" ? "recovered" : "replan_required",
    schema_version: REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION,
    workflow_ref: REPAIR_WORKFLOW_REF,
    work_id: plan.work_id
  };
}

function validatePlanProjection(plan: RepairWorkflowPlan): void {
  if (plan.workflow_ref !== REPAIR_WORKFLOW_REF || plan.schema_version !== REPAIR_WORKFLOW_PROJECTION_SCHEMA_VERSION) {
    throw new Error("Repair completion references an unsupported workflow projection");
  }
  if (plan.status !== "ready") throw new Error("Repair completion requires a ready plan");
  requiredText(plan.handoff.ref, "Repair plan handoff_ref");
  requiredText(plan.handoff.audit_event_ref, "Repair plan handoff audit_event_ref");
  if (plan.diagnosis_evidence_ids.length === 0 ||
      new Set(plan.diagnosis_evidence_ids).size !== plan.diagnosis_evidence_ids.length) {
    throw new Error("Repair plan requires unique diagnosis Evidence ids");
  }
  validateBudget(plan.budget);
  if (clean(plan.action_candidate.action_type) !== plan.action_type) {
    throw new Error("Repair plan action does not match the recovery candidate");
  }
  if (!authorizedAction(plan.action_candidate, plan.action_type)) {
    throw new Error(`Repair action ${plan.action_type} is not authorized by the deterministic gate policy`);
  }
  if (plan.failure_class === "transient") {
    if (plan.budget.status !== "allow" || plan.diagnosis.failure_class !== "transient" ||
        plan.handoff.mode !== "continue" || plan.action_type === "needs_user.escalate") {
      throw new Error("transient Repair plan is inconsistent with diagnosis, budget, action, or Handoff");
    }
    return;
  }
  if (plan.handoff.mode !== "replan" || plan.action_type !== "needs_user.escalate") {
    throw new Error(`${plan.failure_class} Repair plan must stop recovery and replan`);
  }
  if (plan.failure_class === "budget_exhausted") {
    if (plan.budget.status === "allow" || plan.diagnosis.failure_class !== "exhausted") {
      throw new Error("budget-exhausted Repair plan is inconsistent with the canonical budget");
    }
  } else if (plan.budget.status !== "allow" ||
      !["needs_context", "unsafe"].includes(plan.diagnosis.failure_class)) {
    throw new Error("permanent Repair plan is inconsistent with diagnosis or budget");
  }
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

function validatePlanInput(input: RepairWorkflowPlanInput): void {
  requiredText(input.event_id, "Repair event_id");
  requiredText(input.project_id, "Repair project_id");
  requiredText(input.diagnosis_code, "Repair diagnosis_code");
  requiredText(input.handoff_ref, "Repair handoff_ref");
  requiredText(input.handoff_audit_event_ref, "Repair handoff audit_event_ref");
  if (!Number.isSafeInteger(input.issue_id) || input.issue_id <= 0) throw new Error("Repair issue_id must be positive");
  if (input.diagnosis_evidence.length === 0) throw new Error("Repair requires diagnosis Evidence");
  const ids = new Set<string>();
  let matched = false;
  for (const evidence of input.diagnosis_evidence) {
    validateTrustedEvidence(evidence, input.work_id, "diagnosis");
    if (ids.has(evidence.id)) throw new Error(`Repair diagnosis Evidence is duplicated: ${evidence.id}`);
    ids.add(evidence.id);
    if (evidence.decisive_output.facts.diagnosis_code === input.diagnosis_code) matched = true;
  }
  if (!matched) throw new Error("Repair diagnosis Evidence does not prove the selected diagnosis_code");
  validateBudget(input.budget);
}

function validateBudget(budget: PiRecoveryBudgetDecision): void {
  for (const [name, value] of [
    ["issue_attempts_24h", budget.issue_attempts_24h],
    ["issue_budget_remaining", budget.issue_budget_remaining],
    ["project_attempts_1h", budget.project_attempts_1h],
    ["project_budget_remaining", budget.project_budget_remaining],
    ["session_resume_attempts_24h", budget.session_resume_attempts_24h],
    ["session_resume_budget_remaining", budget.session_resume_budget_remaining]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Repair recovery budget ${name} is invalid`);
  }
  if (budget.status === "allow") {
    if (budget.diagnosis_code !== "" || budget.recommended_action !== "allow") {
      throw new Error("allow recovery budget has an inconsistent diagnosis or recommendation");
    }
    return;
  }
  if (budget.recommended_action === "allow") throw new Error("exhausted recovery budget cannot recommend allow");
  if (budget.status !== "project_budget_exhausted" && budget.diagnosis_code === "") {
    throw new Error("exhausted recovery budget requires a deterministic diagnosis_code");
  }
}

function validateTrustedEvidence(evidence: EvidenceRecord, workID: WorkID, label: string): void {
  const validation = validateEvidence(evidence);
  if (!validation.ok) throw new Error(`Repair ${label} Evidence ${evidence.id} is invalid: ${validation.errors.join("; ")}`);
  if (!canSatisfyEvidenceGate(evidence)) throw new Error(`Repair ${label} Evidence ${evidence.id} is not trusted and passed`);
  if (evidence.work_id !== workID) throw new Error(`Repair ${label} Evidence ${evidence.id} belongs to another Work`);
}

function authorizedAction(candidate: Record<string, unknown>, actionType: string): boolean {
  const gate = object(candidate.gate_policy);
  const actions = Array.isArray(gate?.authorizedActions) ? gate.authorizedActions : [];
  return actions.some((item) => object(item)?.action_type === actionType);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} is required`);
  return normalized;
}
