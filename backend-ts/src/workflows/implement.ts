import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  validateEvidence,
  type EvidenceID,
  type EvidenceRecord,
  type RunID,
  type WorkID
} from "../domain/evidence/contracts.ts";
import {
  evaluateWorkflowVerificationPolicy,
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import {
  validateHandoff,
  type HandoffLinkContext,
  type HandoffRecord
} from "../domain/handoff/contracts.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

export const IMPLEMENT_WORKFLOW_SOURCE_PATH = "builtin:workflows/implement@1" as const;
export const IMPLEMENT_WORKFLOW_RUN_SCHEMA_VERSION = "xw.implement-workflow-run.v1" as const;
export const IMPLEMENT_STAGE_IDS = [
  "confirm-target",
  "modify",
  "focused-verify",
  "regression",
  "handoff"
] as const;
export type ImplementStageID = typeof IMPLEMENT_STAGE_IDS[number];
export type ImplementStageTarget = ImplementStageID | "completed";

export const IMPLEMENT_TARGET_CONFIRMATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:implement-target-confirmation",
  revision: 1,
  name: "Implement target confirmation",
  kind_rules: [],
  required_groups: [{
    id: "target-confirmation",
    operator: "all",
    requirements: [{
      id: "trusted-target-confirmation",
      evidence_kinds: ["human"],
      scope: "work",
      fact_assertions: [{ key: "decision", operator: "equals", expected: "target_confirmed" }],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const IMPLEMENT_CHANGE_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:implement-change-snapshot",
  revision: 1,
  name: "Implement changed-files snapshot",
  kind_rules: [],
  required_groups: [{
    id: "changed-files",
    operator: "all",
    requirements: [{
      id: "conflict-free-change-snapshot",
      evidence_kinds: ["git"],
      scope: "run",
      fact_assertions: [
        { key: "changed_path_count", operator: "truthy" },
        { key: "conflict_count", operator: "equals", expected: 0 }
      ],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const IMPLEMENT_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:implement-command-verification",
  revision: 1,
  name: "Implement focused and regression command verification",
  kind_rules: [],
  required_groups: [{
    id: "command-verification",
    operator: "all",
    requirements: [{
      id: "passed-command-verification",
      evidence_kinds: ["test", "lint", "build", "http", "browser"],
      scope: "run",
      fact_assertions: [{ key: "outcome", operator: "equals", expected: "passed" }],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const IMPLEMENT_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:implement",
  revision: 1,
  name: "Implement",
  description: "Confirm the target, modify scoped files, run focused verification and regression, then create an audited local Handoff.",
  stages: [
    {
      id: "confirm-target",
      name: "Confirm goal and acceptance target",
      agent: { role: "reporter", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "read",
        allowed_tools: [
          "runner-builtin:project_status",
          "runner-builtin:work_read",
          "runner-builtin:run_read",
          "runner-builtin:evidence_list",
          "runner-builtin:evidence_read",
          "runner-builtin:issue_read",
          "runner-builtin:issue_execution_status"
        ],
        allowed_actions: []
      },
      verification_policy_ref: "verification-policy:implement-target-confirmation@1",
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: { mode: "none" },
      handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
    },
    {
      id: "modify",
      name: "Apply the scoped implementation",
      agent: { role: "executor", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [
          "runner-builtin:read",
          "runner-builtin:grep",
          "runner-builtin:find",
          "runner-builtin:ls",
          "runner-builtin:repo_tree",
          "runner-builtin:repo_search",
          "runner-builtin:repo_read_excerpt",
          "runner-builtin:work_read",
          "runner-builtin:work_update",
          "runner-builtin:run_read",
          "runner-builtin:evidence_list",
          "runner-builtin:evidence_read"
        ],
        allowed_actions: ["work.update"]
      },
      verification_policy_ref: "verification-policy:implement-change-snapshot@1",
      retry: { max_attempts: 2, backoff_seconds: [5] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:implement-target-confirmed@1"
      },
      handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
    },
    verificationStage("focused-verify", "Run focused verification"),
    verificationStage("regression", "Run related regression"),
    {
      id: "handoff",
      name: "Prepare the audited Handoff",
      agent: { role: "reporter", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [
          "runner-builtin:work_read",
          "runner-builtin:run_read",
          "runner-builtin:evidence_list",
          "runner-builtin:evidence_read",
          "runner-builtin:handoff_list",
          "runner-builtin:handoff_read"
        ],
        allowed_actions: ["handoff.commit"]
      },
      verification_policy_ref: "verification-policy:implement-command-verification@1",
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: { mode: "none" },
      handoff: {
        mode: "branch_commit",
        required: true,
        project_override_modes: ["local_changes", "branch_commit"]
      }
    }
  ]
};

export const IMPLEMENT_WORKFLOW_REF = workflowManifestRef(IMPLEMENT_WORKFLOW_MANIFEST);

const requiredText = Type.String({ minLength: 1, maxLength: 4096 });
const reference = Type.String({ minLength: 1, maxLength: 8192 });
const timestamp = Type.String({ minLength: 20, maxLength: 35 });
const evidenceID = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});
const workID = Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" });
const runID = Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+$" });
const handoffID = Type.String({ pattern: "^xw:handoff:derived:[A-Za-z0-9._~%-]+$" });
const stageID = Type.Union(IMPLEMENT_STAGE_IDS.map((id) => Type.Literal(id)));
const stageTarget = Type.Union([...IMPLEMENT_STAGE_IDS.map((id) => Type.Literal(id)), Type.Literal("completed")]);

const gateSchema = Type.Object({
  authority: Type.Union([Type.Literal("deterministic_policy"), Type.Literal("human_approval")]),
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("ask")]),
  policy_ref: reference
}, { additionalProperties: false });

export const IMPLEMENT_STAGE_TRANSITION_SCHEMA = Type.Object({
  from: stageID,
  to: stageTarget,
  signal: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked")]),
  confirmation_decision: Type.Optional(Type.Literal("confirmed")),
  change_audit_outcome: Type.Optional(Type.Union([
    Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("not_executed")
  ])),
  verification_decision: Type.Optional(Type.Union([
    Type.Literal("passed"), Type.Literal("pending"), Type.Literal("failed"), Type.Literal("overridden"),
    Type.Literal("invalid")
  ])),
  handoff_status: Type.Optional(Type.Union([
    Type.Literal("draft"), Type.Literal("ready"), Type.Literal("delivered"), Type.Literal("superseded")
  ])),
  reason: requiredText,
  gate: gateSchema,
  audit_event_ref: reference,
  occurred_at: timestamp
}, { additionalProperties: false });

const stageReceiptSchema = Type.Object({
  id: stageID,
  status: Type.Literal("completed"),
  evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 256 }),
  audit_event_refs: Type.Array(reference, { minItems: 1, maxItems: 256 })
}, { additionalProperties: false });

const mutationAuditSchema = Type.Object({
  operation_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" }),
  action: Type.Union([
    Type.Literal("workspace.modify"),
    Type.Literal("work.update"),
    Type.Literal("handoff.commit")
  ]),
  classification: Type.Union([
    Type.Literal("state_change"), Type.Literal("external_write"), Type.Literal("destructive")
  ]),
  target: reference,
  gate: gateSchema,
  outcome: Type.Union([
    Type.Literal("not_executed"), Type.Literal("succeeded"), Type.Literal("failed")
  ]),
  audit_event_ref: reference,
  before_ref: Type.Optional(reference),
  after_ref: Type.Optional(reference),
  rollback_ref: Type.Optional(reference)
}, { additionalProperties: false });

export const IMPLEMENT_WORKFLOW_RUN_SCHEMA = Type.Object({
  schema_version: Type.Literal(IMPLEMENT_WORKFLOW_RUN_SCHEMA_VERSION),
  workflow_ref: Type.Literal(IMPLEMENT_WORKFLOW_REF),
  project_id: Type.String({ minLength: 1, maxLength: 256 }),
  work_id: workID,
  run_id: runID,
  status: Type.Literal("completed"),
  completed_at: timestamp,
  target_confirmation: Type.Object({
    goal: requiredText,
    acceptance_criteria: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" }),
      description: requiredText
    }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
    decision: Type.Literal("confirmed"),
    evidence_id: evidenceID,
    audit_event_ref: reference
  }, { additionalProperties: false }),
  stages: Type.Array(stageReceiptSchema, {
    minItems: IMPLEMENT_STAGE_IDS.length,
    maxItems: IMPLEMENT_STAGE_IDS.length
  }),
  transitions: Type.Array(IMPLEMENT_STAGE_TRANSITION_SCHEMA, {
    minItems: IMPLEMENT_STAGE_IDS.length,
    maxItems: IMPLEMENT_STAGE_IDS.length
  }),
  evidence_ids: Type.Array(evidenceID, { minItems: 4, maxItems: 256 }),
  verification: Type.Object({
    policy_ref: Type.Literal("verification-policy:implement-command-verification@1"),
    focused_evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 128 }),
    regression_evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 128 }),
    decision: Type.Literal("passed"),
    completion_gate_audit_ref: reference
  }, { additionalProperties: false }),
  mutation_audit: Type.Array(mutationAuditSchema, { minItems: 1, maxItems: 128 }),
  handoff: Type.Object({
    id: handoffID,
    mode: Type.Union([Type.Literal("local_changes"), Type.Literal("branch_commit")]),
    status: Type.Union([Type.Literal("ready"), Type.Literal("delivered")]),
    audit_event_refs: Type.Array(reference, { minItems: 1, maxItems: 128 })
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type ImplementStageTransition = Static<typeof IMPLEMENT_STAGE_TRANSITION_SCHEMA>;
export type ImplementWorkflowRun = Static<typeof IMPLEMENT_WORKFLOW_RUN_SCHEMA>;
export type ImplementWorkflowValidation = { errors: string[]; ok: boolean };
export type ImplementWorkflowValidationContext = {
  evidence: readonly EvidenceRecord[];
  handoff: HandoffRecord;
  runs: HandoffLinkContext["runs"];
};

export function implementWorkflowRegistryContributions(): {
  manifests: WorkflowManifestRegistration[];
  verification_policies: WorkflowVerificationPolicy[];
} {
  return {
    manifests: [{
      manifest: structuredClone(IMPLEMENT_WORKFLOW_MANIFEST),
      source_path: IMPLEMENT_WORKFLOW_SOURCE_PATH
    }],
    verification_policies: [
      structuredClone(IMPLEMENT_TARGET_CONFIRMATION_POLICY),
      structuredClone(IMPLEMENT_CHANGE_POLICY),
      structuredClone(IMPLEMENT_VERIFICATION_POLICY)
    ]
  };
}

export function parseImplementWorkflowRunJSON(
  text: string,
  context?: ImplementWorkflowValidationContext
): { ok: true; run: ImplementWorkflowRun } | { errors: string[]; ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "invalid JSON"], ok: false };
  }
  const validation = validateImplementWorkflowRun(value, context);
  return validation.ok
    ? { ok: true, run: value as ImplementWorkflowRun }
    : { errors: validation.errors, ok: false };
}

export function evaluateImplementStageTransition(
  transition: ImplementStageTransition
): { allowed: boolean; violations: string[] } {
  const violations: string[] = [];
  if (!Value.Check(IMPLEMENT_STAGE_TRANSITION_SCHEMA, transition)) {
    return {
      allowed: false,
      violations: [...Value.Errors(IMPLEMENT_STAGE_TRANSITION_SCHEMA, transition)].map((error) =>
        `schema ${error.path || "/"}: ${error.message}`
      )
    };
  }
  if (!isIsoTimestamp(transition.occurred_at)) violations.push("transition occurred_at must be an ISO timestamp");
  if (transition.gate.decision !== "allow") violations.push("transition gate must allow the stage change");
  if (transition.signal === "blocked") violations.push("blocked stages cannot transition");

  const expected = expectedTransition(transition.from, transition.signal);
  if (expected !== transition.to) {
    violations.push(`illegal Implement stage transition ${transition.from} -> ${transition.to} for ${transition.signal}`);
  }
  if (transition.from === "confirm-target" && transition.confirmation_decision !== "confirmed") {
    violations.push("confirm-target requires trusted target confirmation");
  }
  if (transition.from === "modify" && transition.change_audit_outcome !== "succeeded") {
    violations.push("modify requires a succeeded audited change outcome");
  }
  if (["focused-verify", "regression"].includes(transition.from) &&
    transition.verification_decision !== transition.signal) {
    violations.push(`${transition.from} transition must match its verification decision`);
  }
  if (transition.from === "handoff") {
    if (transition.verification_decision !== "passed") {
      violations.push("handoff completion requires passed deterministic verification");
    }
    if (transition.handoff_status !== "ready" && transition.handoff_status !== "delivered") {
      violations.push("handoff completion requires a ready or delivered Handoff");
    }
  }
  return { allowed: violations.length === 0, violations };
}

export function validateImplementWorkflowRun(
  input: unknown,
  context?: ImplementWorkflowValidationContext
): ImplementWorkflowValidation {
  if (!Value.Check(IMPLEMENT_WORKFLOW_RUN_SCHEMA, input)) {
    return {
      errors: [...Value.Errors(IMPLEMENT_WORKFLOW_RUN_SCHEMA, input)].map((error) =>
        `schema ${error.path || "/"}: ${error.message}`
      ),
      ok: false
    };
  }
  const run = input as ImplementWorkflowRun;
  const errors: string[] = [];
  if (!isIsoTimestamp(run.completed_at)) errors.push("completed_at must be an ISO timestamp");
  orderedStages(run, errors);
  validateTransitions(run, errors);
  validateReceiptLinks(run, errors);
  validateMutationAudit(run, errors);
  if (context) validateRuntimeLinks(run, context, errors);
  return { errors: [...new Set(errors)], ok: errors.length === 0 };
}

function verificationStage(id: "focused-verify" | "regression", name: string): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role: "verifier", required_skill_ids: [] },
    permissions: {
      max_tool_permission: "read",
      allowed_tools: [
        "runner-builtin:read",
        "runner-builtin:grep",
        "runner-builtin:find",
        "runner-builtin:ls",
        "runner-builtin:repo_tree",
        "runner-builtin:repo_search",
        "runner-builtin:repo_read_excerpt",
        "runner-builtin:work_read",
        "runner-builtin:run_read",
        "runner-builtin:evidence_list",
        "runner-builtin:evidence_read"
      ],
      allowed_actions: []
    },
    verification_policy_ref: "verification-policy:implement-command-verification@1",
    retry: { max_attempts: 2, backoff_seconds: [5] },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
  };
}

function expectedTransition(from: ImplementStageID, signal: ImplementStageTransition["signal"]): ImplementStageTarget | null {
  if (from === "confirm-target") return signal === "passed" ? "modify" : null;
  if (from === "modify") return signal === "passed" ? "focused-verify" : null;
  if (from === "focused-verify") return signal === "passed" ? "regression" : signal === "failed" ? "modify" : null;
  if (from === "regression") return signal === "passed" ? "handoff" : signal === "failed" ? "modify" : null;
  return signal === "passed" ? "completed" : null;
}

function orderedStages(run: ImplementWorkflowRun, errors: string[]): void {
  const ids = run.stages.map((stage) => stage.id);
  if (ids.some((id, index) => id !== IMPLEMENT_STAGE_IDS[index])) {
    errors.push(`stages must be ordered exactly as ${IMPLEMENT_STAGE_IDS.join(", ")}`);
  }
  for (const stage of run.stages) {
    unique(stage.evidence_ids, `${stage.id} evidence_ids`, errors);
    unique(stage.audit_event_refs, `${stage.id} audit_event_refs`, errors);
  }
}

function validateTransitions(run: ImplementWorkflowRun, errors: string[]): void {
  const expectedTargets: ImplementStageTarget[] = ["modify", "focused-verify", "regression", "handoff", "completed"];
  run.transitions.forEach((transition, index) => {
    if (transition.from !== IMPLEMENT_STAGE_IDS[index] || transition.to !== expectedTargets[index]) {
      errors.push("completed run transitions must follow the canonical forward stage order");
    }
    const decision = evaluateImplementStageTransition(transition);
    errors.push(...decision.violations);
  });
  unique(run.transitions.map((transition) => transition.audit_event_ref), "transition audit refs", errors);
}

function validateReceiptLinks(run: ImplementWorkflowRun, errors: string[]): void {
  unique(run.evidence_ids, "evidence_ids", errors);
  unique(run.target_confirmation.acceptance_criteria.map((item) => item.id), "acceptance criteria ids", errors);
  unique(run.verification.focused_evidence_ids, "focused Evidence ids", errors);
  unique(run.verification.regression_evidence_ids, "regression Evidence ids", errors);
  const declared = new Set(run.evidence_ids);
  const stageByID = new Map(run.stages.map((stage) => [stage.id, stage]));
  for (const stage of run.stages) {
    for (const id of stage.evidence_ids) {
      if (!declared.has(id)) errors.push(`${stage.id} references undeclared Evidence ${id}`);
    }
  }
  for (const id of declared) {
    if (!run.stages.some((stage) => stage.evidence_ids.includes(id))) {
      errors.push(`Evidence ${id} is not linked to a stage`);
    }
  }
  if (!stageByID.get("confirm-target")?.evidence_ids.includes(run.target_confirmation.evidence_id)) {
    errors.push("target confirmation Evidence must be linked to confirm-target");
  }
  if (!stageByID.get("confirm-target")?.audit_event_refs.includes(run.target_confirmation.audit_event_ref)) {
    errors.push("target confirmation audit must be linked to confirm-target");
  }
  for (const id of run.verification.focused_evidence_ids) {
    if (!stageByID.get("focused-verify")?.evidence_ids.includes(id)) {
      errors.push(`focused Evidence ${id} must be linked to focused-verify`);
    }
  }
  for (const id of run.verification.regression_evidence_ids) {
    if (!stageByID.get("regression")?.evidence_ids.includes(id)) {
      errors.push(`regression Evidence ${id} must be linked to regression`);
    }
    if (run.verification.focused_evidence_ids.includes(id)) {
      errors.push(`focused and regression verification must use distinct Evidence: ${id}`);
    }
  }
  for (const id of run.evidence_ids) {
    if (!stageByID.get("handoff")?.evidence_ids.includes(id)) {
      errors.push(`handoff stage must carry Evidence ${id}`);
    }
  }
  const handoffAudits = stageByID.get("handoff")!.audit_event_refs;
  if (!handoffAudits.includes(run.verification.completion_gate_audit_ref)) {
    errors.push("completion gate audit must be linked to handoff stage");
  }
  for (const ref of run.handoff.audit_event_refs) {
    if (!handoffAudits.includes(ref)) errors.push(`Handoff audit ${ref} must be linked to handoff stage`);
  }
}

function validateMutationAudit(run: ImplementWorkflowRun, errors: string[]): void {
  unique(run.mutation_audit.map((item) => item.operation_id), "mutation operation ids", errors);
  unique(run.mutation_audit.map((item) => item.audit_event_ref), "mutation audit refs", errors);
  const modifyStage = run.stages.find((stage) => stage.id === "modify")!;
  const handoffStage = run.stages.find((stage) => stage.id === "handoff")!;
  const workspaceChange = run.mutation_audit.find((item) => item.action === "workspace.modify");
  if (!workspaceChange) errors.push("completed Implement run requires an audited workspace.modify operation");
  else if (!modifyStage.audit_event_refs.includes(workspaceChange.audit_event_ref)) {
    errors.push("workspace.modify audit must be linked to modify stage");
  }
  for (const operation of run.mutation_audit) {
    if (operation.outcome !== "succeeded") errors.push(`${operation.action} must succeed before completion`);
    if (operation.gate.decision !== "allow") errors.push(`${operation.action} cannot execute without an allow gate`);
    if (operation.classification !== "state_change") {
      errors.push(`Implement local Handoff forbids ${operation.classification} operation ${operation.action}`);
    }
    if (operation.outcome === "succeeded" && !operation.after_ref?.trim()) {
      errors.push(`succeeded ${operation.action} requires after_ref`);
    }
    const expectedStage = operation.action === "handoff.commit" ? handoffStage : modifyStage;
    if (!expectedStage.audit_event_refs.includes(operation.audit_event_ref)) {
      errors.push(`${operation.action} audit must be linked to ${expectedStage.id} stage`);
    }
  }
  const commit = run.mutation_audit.find((item) => item.action === "handoff.commit");
  if (run.handoff.mode === "branch_commit") {
    if (!commit) errors.push("branch_commit mode requires an audited handoff.commit operation");
    else if (!handoffStage.audit_event_refs.includes(commit.audit_event_ref)) {
      errors.push("handoff.commit audit must be linked to handoff stage");
    }
  } else if (commit) {
    errors.push("local_changes mode cannot claim a handoff.commit operation");
  }
}

function validateRuntimeLinks(
  run: ImplementWorkflowRun,
  context: ImplementWorkflowValidationContext,
  errors: string[]
): void {
  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  for (const id of run.evidence_ids) {
    const item = evidence.get(id as EvidenceID);
    if (!item) {
      errors.push(`linked Evidence is missing: ${id}`);
      continue;
    }
    const validation = validateEvidence(item);
    if (!validation.ok) errors.push(`linked Evidence ${id} is invalid: ${validation.errors.join("; ")}`);
    if (item.work_id !== run.work_id) errors.push(`linked Evidence ${id} belongs to another Work`);
    if (item.run_id && item.run_id !== run.run_id) errors.push(`linked Evidence ${id} belongs to another Run`);
  }

  const stages = new Map(run.stages.map((stage) => [stage.id, stage]));
  requirePolicyPass(run, context.evidence, stages.get("confirm-target")!.evidence_ids,
    IMPLEMENT_TARGET_CONFIRMATION_POLICY, "confirm-target", errors);
  requirePolicyPass(run, context.evidence, stages.get("modify")!.evidence_ids,
    IMPLEMENT_CHANGE_POLICY, "modify", errors);
  requirePolicyPass(run, context.evidence, run.verification.focused_evidence_ids,
    IMPLEMENT_VERIFICATION_POLICY, "focused-verify", errors);
  requirePolicyPass(run, context.evidence, run.verification.regression_evidence_ids,
    IMPLEMENT_VERIFICATION_POLICY, "regression", errors);

  const handoff = context.handoff;
  const handoffValidation = validateHandoff(handoff, {
    evidence: context.evidence.map((item) => ({ id: item.id, status: item.status, work_id: item.work_id })),
    runs: [...context.runs]
  });
  if (!handoffValidation.ok) errors.push(...handoffValidation.errors.map((error) => `Handoff: ${error}`));
  if (handoff.id !== run.handoff.id) errors.push("receipt references another Handoff");
  if (handoff.work_id !== run.work_id) errors.push("Handoff belongs to another Work");
  if (!handoff.run_ids.includes(run.run_id as RunID)) errors.push("Handoff does not link the Implement Run");
  if (handoff.delivery.mode !== run.handoff.mode) errors.push("Handoff delivery mode does not match receipt");
  if (handoff.status !== run.handoff.status) errors.push("Handoff status does not match receipt");
  for (const id of run.evidence_ids) {
    if (!handoff.evidence_ids.includes(id as EvidenceID)) errors.push(`Handoff is missing Evidence ${id}`);
  }
  for (const action of handoff.delivery_actions) {
    if (action.classification !== "state_change") {
      errors.push(`Implement V1 local Handoff cannot execute ${action.classification} delivery action ${action.action}`);
    }
  }
  if (run.handoff.mode === "branch_commit" && !handoff.delivery_actions.some((action) =>
    action.action === "commit" && action.outcome === "succeeded" && action.gate_decision === "allow"
  )) {
    errors.push("branch_commit Handoff requires a succeeded audited commit action");
  }
  for (const action of handoff.delivery_actions) {
    if (!run.handoff.audit_event_refs.includes(action.audit_event_ref)) {
      errors.push(`receipt Handoff audit refs are missing ${action.audit_event_ref}`);
    }
  }
}

function requirePolicyPass(
  run: ImplementWorkflowRun,
  allEvidence: readonly EvidenceRecord[],
  ids: readonly string[],
  policy: WorkflowVerificationPolicy,
  stage: ImplementStageID,
  errors: string[]
): void {
  const selected = new Set(ids);
  const evaluation = evaluateWorkflowVerificationPolicy({
    context: {
      now: run.completed_at,
      project_id: run.project_id,
      risk: "safe",
      run_id: run.run_id as RunID,
      work_id: run.work_id as WorkID
    },
    evidence: allEvidence.filter((item) => selected.has(item.id)),
    policy
  });
  if (evaluation.decision !== "passed" || !evaluation.satisfied) {
    errors.push(`${stage} verification policy did not pass: ${evaluation.decision}`);
  }
}

function unique(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} must be unique`);
}

function isIsoTimestamp(value: string | undefined): value is string {
  if (!value || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
