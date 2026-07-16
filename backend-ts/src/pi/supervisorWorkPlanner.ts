import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi/actions.ts";
import {
  validateAcceptanceContract,
  type WorkAcceptanceContract
} from "../domain/work/contracts.ts";
import type { WorkflowRegistry, WorkflowResolution } from "../workflows/registry.ts";
import type { WorkID } from "../xuanwu/coreDomainContracts.ts";
import type { SupervisorContextResolution } from "./supervisorContextResolver.ts";
import type { SupervisorIntentKind, SupervisorIntentRoute } from "./supervisorIntentRouter.ts";

export const SUPERVISOR_WORK_PLAN_SCHEMA_VERSION = "xw.supervisor-work-plan.v1" as const;
export const SUPERVISOR_PLAN_MAX_DEPTH = 1 as const;
export const SUPERVISOR_PLAN_MAX_WORK_ITEMS = 8 as const;
export const SUPERVISOR_PLAN_MAX_DEPENDENCIES = 16 as const;

export const SUPERVISOR_PLAN_WORKFLOW_PURPOSES = [
  "investigate",
  "implement",
  "release"
] as const;
export type SupervisorPlanWorkflowPurpose = typeof SUPERVISOR_PLAN_WORKFLOW_PURPOSES[number];

const objectOptions = { additionalProperties: false } as const;
const approvalModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("before_external_write"),
  Type.Literal("before_stage")
]);
const workflowPurposeSchema = Type.Union(
  SUPERVISOR_PLAN_WORKFLOW_PURPOSES.map((purpose) => Type.Literal(purpose))
);
const planWorkIDSchema = Type.String({
  pattern: "^xw:work:supervisor_plan:[a-f0-9]{16}-(root|step-[1-7])$"
});
const verificationPolicyRefSchema = Type.String({
  pattern: "^verification-policy:[a-z][a-z0-9._-]{0,127}@[1-9][0-9]*$"
});
const acceptanceSchema = Type.Object({
  completion_rule: Type.Literal("all_required"),
  criteria: Type.Array(Type.Object({
    description: Type.String({ minLength: 1, maxLength: 4096 }),
    id: Type.String({ minLength: 1, maxLength: 128 }),
    required: Type.Boolean(),
    verification_policy_ref: verificationPolicyRefSchema
  }, objectOptions), { minItems: 1, maxItems: 64 }),
  requires_handoff: Type.Literal(true),
  version: Type.Integer({ minimum: 1 })
}, objectOptions);

const workflowSelectionSchema = Type.Object({
  approval_modes: Type.Array(approvalModeSchema, { maxItems: 64 }),
  manifest_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  project_override_applied: Type.Boolean(),
  project_override_audit_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  purpose: workflowPurposeSchema,
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
  requested_ref: Type.String({ maxLength: 256 }),
  source_path: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  status: Type.Union([
    Type.Literal("selected"),
    Type.Literal("unavailable"),
    Type.Literal("not_required")
  ]),
  verification_policy_refs: Type.Array(verificationPolicyRefSchema, { maxItems: 64 })
}, objectOptions);

const plannedWorkSchema = Type.Object({
  acceptance: acceptanceSchema,
  depth: Type.Integer({ minimum: 0, maximum: SUPERVISOR_PLAN_MAX_DEPTH }),
  goal: Type.String({ minLength: 1, maxLength: 4096 }),
  id: planWorkIDSchema,
  owner: Type.Object({
    kind: Type.Literal("project"),
    project_id: Type.String({ minLength: 1, maxLength: 256 })
  }, objectOptions),
  parent_work_id: Type.Optional(planWorkIDSchema),
  status: Type.Literal("triage"),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  type: Type.Union([Type.Literal("objective"), Type.Literal("engineering_task")]),
  workflow_ref: Type.String({ minLength: 1, maxLength: 256 })
}, objectOptions);

const dependencySchema = Type.Object({
  depends_on_work_id: planWorkIDSchema,
  work_id: planWorkIDSchema
}, objectOptions);

export const SUPERVISOR_WORK_PLAN_SCHEMA = Type.Object({
  approval_policy: Type.Object({
    decision: Type.Union([
      Type.Literal("not_required"),
      Type.Literal("ask_user"),
      Type.Literal("blocked")
    ]),
    gate_authority: Type.Literal("deterministic_supervisor_plan_policy"),
    materialization_permitted: Type.Literal(false),
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
    required: Type.Boolean(),
    required_before: Type.Array(Type.Union([
      Type.Literal("plan_materialization"),
      Type.Literal("stage_execution"),
      Type.Literal("external_write")
    ]), { maxItems: 3 }),
    scope: Type.Union([
      Type.Literal("none"),
      Type.Literal("plan_materialization"),
      Type.Literal("stage_execution"),
      Type.Literal("external_write")
    ])
  }, objectOptions),
  bounds: Type.Object({
    actual_depth: Type.Integer({ minimum: 0, maximum: SUPERVISOR_PLAN_MAX_DEPTH }),
    max_dependencies: Type.Literal(SUPERVISOR_PLAN_MAX_DEPENDENCIES),
    max_depth: Type.Literal(SUPERVISOR_PLAN_MAX_DEPTH),
    max_work_items: Type.Literal(SUPERVISOR_PLAN_MAX_WORK_ITEMS),
    original_step_count: Type.Integer({ minimum: 0 }),
    planned_step_count: Type.Integer({ minimum: 0, maximum: SUPERVISOR_PLAN_MAX_WORK_ITEMS - 1 }),
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
    truncated: Type.Boolean()
  }, objectOptions),
  dependencies: Type.Array(dependencySchema, { maxItems: SUPERVISOR_PLAN_MAX_DEPENDENCIES }),
  goal: Type.String({ minLength: 1, maxLength: 4096 }),
  input_audit: Type.Object({
    context_status: Type.Union([
      Type.Literal("resolved"), Type.Literal("ambiguous"), Type.Literal("missing")
    ]),
    goal_digest: Type.String({ minLength: 16, maxLength: 16 }),
    intent_decision: Type.String({ minLength: 1 }),
    source: Type.String({ minLength: 1 })
  }, objectOptions),
  materialization: Type.Object({
    authority: Type.Literal("issues-via-work-adapter"),
    mode: Type.Union([Type.Literal("none"), Type.Literal("proposal_only")]),
    relation_write: Type.Literal("plan_only-before-G4"),
    state_writes: Type.Literal("not_executed")
  }, objectOptions),
  mode: Type.Union([
    Type.Literal("no_work"), Type.Literal("read_only"), Type.Literal("work_plan")
  ]),
  plan_id: Type.String({ pattern: "^supervisor-plan:[a-f0-9]{16}$" }),
  project_id: Type.String({ maxLength: 256 }),
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
  schema_version: Type.Literal(SUPERVISOR_WORK_PLAN_SCHEMA_VERSION),
  status: Type.Union([
    Type.Literal("ready"), Type.Literal("needs_clarification"), Type.Literal("blocked")
  ]),
  target_work_ids: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 }),
  workflow_selections: Type.Array(workflowSelectionSchema, { maxItems: 3 }),
  works: Type.Array(plannedWorkSchema, { maxItems: SUPERVISOR_PLAN_MAX_WORK_ITEMS })
}, objectOptions);

export type SupervisorWorkPlan = Static<typeof SUPERVISOR_WORK_PLAN_SCHEMA>;
export type SupervisorPlannedWork = SupervisorWorkPlan["works"][number];
export type SupervisorPlanWorkflowSelection = SupervisorWorkPlan["workflow_selections"][number];

export type SupervisorPlannerWorkflowRefs = Partial<Record<SupervisorPlanWorkflowPurpose, string>>;
export type SupervisorWorkPlannerInput = {
  context: SupervisorContextResolution;
  goal: string;
  intent_route: SupervisorIntentRoute;
  source?: string;
  workflow_refs: SupervisorPlannerWorkflowRefs;
  workflow_registry: Pick<WorkflowRegistry, "resolve">;
};

export type SupervisorPlanApproval = {
  actor: { id: string; kind: "user" | "supervisor" | "automation" | "system" };
  audit_event_ref: string;
  decision: "approve" | "reject";
  occurred_at: string;
  plan_id: string;
};

export type SupervisorPlanApprovalEvaluation = {
  decision: "allow" | "ask" | "deny";
  planner_precondition_satisfied: boolean;
  reasons: string[];
  tool_permission_granted: false;
};

type PlannedStep = { goal: string; purpose: Exclude<SupervisorPlanWorkflowPurpose, "investigate"> };

export function planSupervisorWork(input: SupervisorWorkPlannerInput): SupervisorWorkPlan {
  const goal = boundedText(input.goal, 4096);
  if (goal === "") throw new Error("Supervisor planner goal is required");
  const projectID = cleanString(input.context.target.project_id);
  const planDigest = digest(JSON.stringify({
    context: input.context.input_audit.input_digest,
    goal,
    intents: input.intent_route.intents.map((intent) => intent.kind),
    project_id: projectID,
    route: input.intent_route.input_audit.input_digest
  }));
  const planID = `supervisor-plan:${planDigest}` as const;
  const mode = planMode(input.intent_route);
  const clarification = clarificationReason(mode, input.intent_route, input.context);
  const rawSteps = mode === "work_plan" ? decomposeGoal(goal, input.intent_route) : [];
  const boundedSteps = boundSteps(rawSteps);
  const purposes = requiredPurposes(mode, boundedSteps.steps, input.intent_route);
  const selections = purposes.map((purpose) => selectWorkflow(
    purpose,
    projectID,
    input.workflow_refs,
    input.workflow_registry,
    clarification !== ""
  ));
  const unavailable = mode === "work_plan" && selections.some((selection) => selection.status !== "selected");
  const status = clarification !== "" ? "needs_clarification" : unavailable ? "blocked" : "ready";
  const works = status === "ready" && mode === "work_plan"
    ? plannedWorks(planDigest, projectID, goal, boundedSteps.steps, selections)
    : [];
  const dependencies = works.length > 1 ? sequentialDependencies(works) : [];
  const planApprovalPolicy = buildApprovalPolicy(status, mode, works, selections);
  const plan: SupervisorWorkPlan = {
    approval_policy: planApprovalPolicy,
    bounds: {
      actual_depth: works.some((work) => work.depth === 1) ? 1 : 0,
      max_dependencies: SUPERVISOR_PLAN_MAX_DEPENDENCIES,
      max_depth: SUPERVISOR_PLAN_MAX_DEPTH,
      max_work_items: SUPERVISOR_PLAN_MAX_WORK_ITEMS,
      original_step_count: rawSteps.length,
      planned_step_count: boundedSteps.steps.length,
      reason: boundedSteps.reason,
      truncated: boundedSteps.truncated
    },
    dependencies,
    goal,
    input_audit: {
      context_status: input.context.status,
      goal_digest: digest(goal),
      intent_decision: input.intent_route.decision,
      source: cleanString(input.source) || input.intent_route.source_trust.source
    },
    materialization: {
      authority: "issues-via-work-adapter",
      mode: mode === "work_plan" ? "proposal_only" : "none",
      relation_write: "plan_only-before-G4",
      state_writes: "not_executed"
    },
    mode,
    plan_id: planID,
    project_id: projectID,
    reason: planReason(status, mode, clarification, selections),
    schema_version: SUPERVISOR_WORK_PLAN_SCHEMA_VERSION,
    status,
    target_work_ids: input.context.target.work_ids.slice(0, 64),
    workflow_selections: selections,
    works
  };
  const errors = validateSupervisorWorkPlan(plan);
  if (errors.length > 0) throw new Error(`Supervisor work plan failed validation: ${errors.join("; ")}`);
  return plan;
}

export function validateSupervisorWorkPlan(input: unknown): string[] {
  if (!Value.Check(SUPERVISOR_WORK_PLAN_SCHEMA, input)) return ["plan schema is invalid"];
  const plan = input as SupervisorWorkPlan;
  const errors: string[] = [];
  const works = new Map(plan.works.map((work) => [work.id, work]));
  if (works.size !== plan.works.length) errors.push("planned Work ids must be unique");
  if (plan.works.length > SUPERVISOR_PLAN_MAX_WORK_ITEMS) errors.push("planned Work count exceeds bound");
  if (plan.dependencies.length > SUPERVISOR_PLAN_MAX_DEPENDENCIES) errors.push("dependency count exceeds bound");
  if (plan.mode !== "work_plan" && (plan.works.length > 0 || plan.dependencies.length > 0)) {
    errors.push("read-only and no-Work plans cannot contain Work mutations");
  }
  if (plan.status === "ready" && plan.mode === "work_plan" && plan.works.length === 0) {
    errors.push("ready Work plan requires at least one planned Work");
  }

  const selectedRefs = new Set(plan.workflow_selections
    .filter((selection) => selection.status === "selected")
    .map((selection) => selection.manifest_ref));
  const parentEdges: Array<[string, string]> = [];
  for (const work of plan.works) {
    if (work.owner.project_id !== plan.project_id) errors.push(`${work.id} has another project owner`);
    errors.push(...validateAcceptanceContract(work.acceptance).map((error) => `${work.id} ${error}`));
    if (!selectedRefs.has(work.workflow_ref)) errors.push(`${work.id} workflow_ref was not selected by Registry`);
    if (work.parent_work_id) {
      const parent = works.get(work.parent_work_id);
      if (!parent) errors.push(`${work.id} references missing parent ${work.parent_work_id}`);
      else if (parent.id === work.id) errors.push(`${work.id} cannot parent itself`);
      else if (parent.depth >= work.depth) errors.push(`${work.id} parent depth must be lower`);
      parentEdges.push([work.parent_work_id, work.id]);
    } else if (work.depth !== 0) {
      errors.push(`${work.id} without parent must be depth 0`);
    }
  }

  const dependencyKeys = new Set<string>();
  const dependencyEdges: Array<[string, string]> = [];
  for (const dependency of plan.dependencies) {
    const key = `${dependency.work_id}:${dependency.depends_on_work_id}`;
    if (dependencyKeys.has(key)) errors.push(`duplicate dependency ${key}`);
    dependencyKeys.add(key);
    if (!works.has(dependency.work_id)) errors.push(`dependency references missing Work ${dependency.work_id}`);
    if (!works.has(dependency.depends_on_work_id)) {
      errors.push(`dependency references missing Work ${dependency.depends_on_work_id}`);
    }
    if (dependency.work_id === dependency.depends_on_work_id) errors.push(`${dependency.work_id} cannot depend on itself`);
    dependencyEdges.push([dependency.work_id, dependency.depends_on_work_id]);
  }
  const nodes = [...works.keys()];
  if (hasDirectedCycle(nodes, parentEdges)) errors.push("parent/child cycle detected");
  if (hasDirectedCycle(nodes, dependencyEdges)) errors.push("dependency cycle detected");
  const actualDepth = Math.max(0, ...plan.works.map((work) => work.depth));
  if (actualDepth !== plan.bounds.actual_depth) errors.push("bounds.actual_depth does not match planned Work");
  return errors;
}

export function evaluateSupervisorPlanApproval(
  plan: SupervisorWorkPlan,
  approval?: SupervisorPlanApproval
): SupervisorPlanApprovalEvaluation {
  const reasons: string[] = [];
  if (plan.mode !== "work_plan") reasons.push("plan has no Work to materialize");
  if (plan.status !== "ready") reasons.push(`plan is ${plan.status}`);
  if (reasons.length > 0) return approvalEvaluation("deny", false, reasons);
  if (!plan.approval_policy.required) {
    return approvalEvaluation("allow", true, [
      "planner user-approval precondition is not required; deterministic mutation gates still apply"
    ]);
  }
  if (!approval) {
    return approvalEvaluation("ask", false, [plan.approval_policy.reason]);
  }
  if (approval.plan_id !== plan.plan_id) reasons.push("approval references another plan");
  if (approval.actor.kind !== "user" || cleanString(approval.actor.id) === "") {
    reasons.push("approval must come from an identified user");
  }
  if (cleanString(approval.audit_event_ref) === "") reasons.push("approval audit_event_ref is required");
  if (!Number.isFinite(Date.parse(approval.occurred_at))) reasons.push("approval occurred_at must be a timestamp");
  if (approval.decision === "reject") reasons.push("user rejected the plan");
  return reasons.length > 0
    ? approvalEvaluation("deny", false, reasons)
    : approvalEvaluation("allow", true, [
      "user approval precondition is satisfied; deterministic mutation and stage gates still apply"
    ]);
}

export function recordSupervisorWorkPlanAudit(
  db: RunnerDatabase,
  input: { conversationID: string; turnID: string },
  plan: SupervisorWorkPlan
): void {
  createPiActionEvent(db, {
    action_id: `work-plan:${cleanString(input.turnID) || plan.plan_id}`,
    actor: "supervisor_work_planner",
    conversation_id: cleanString(input.conversationID),
    decision: plan.status,
    event_type: "supervisor_work_planned",
    payload_json: JSON.stringify(plan),
    project_id: plan.project_id,
    reason: plan.reason
  });
}

function planMode(route: SupervisorIntentRoute): SupervisorWorkPlan["mode"] {
  const kinds = new Set(route.intents.map((intent) => intent.kind));
  if (["execute", "automation", "release"].some((kind) => kinds.has(kind as SupervisorIntentKind))) {
    return "work_plan";
  }
  if (kinds.has("investigate")) return "read_only";
  return "no_work";
}

function clarificationReason(
  mode: SupervisorWorkPlan["mode"],
  route: SupervisorIntentRoute,
  context: SupervisorContextResolution
): string {
  if (route.clarification.required) return route.clarification.question || route.clarification.reason;
  if (mode === "work_plan" && context.status !== "resolved") {
    return context.clarification.question || context.clarification.reason;
  }
  return "";
}

function requiredPurposes(
  mode: SupervisorWorkPlan["mode"],
  steps: PlannedStep[],
  route: SupervisorIntentRoute
): SupervisorPlanWorkflowPurpose[] {
  if (mode === "read_only") return ["investigate"];
  if (mode !== "work_plan") return [];
  const purposes = new Set(steps.map((step) => step.purpose));
  if (route.intents.some((intent) => intent.kind === "release")) purposes.add("release");
  if (purposes.size === 0) purposes.add("implement");
  return SUPERVISOR_PLAN_WORKFLOW_PURPOSES.filter((purpose) => purposes.has(purpose as PlannedStep["purpose"]));
}

function selectWorkflow(
  purpose: SupervisorPlanWorkflowPurpose,
  projectID: string,
  refs: SupervisorPlannerWorkflowRefs,
  registry: Pick<WorkflowRegistry, "resolve">,
  notRequired: boolean
): SupervisorPlanWorkflowSelection {
  const requestedRef = cleanString(refs[purpose]);
  if (notRequired) return unavailableSelection(purpose, requestedRef, "target clarification is required", "not_required");
  if (requestedRef === "") return unavailableSelection(purpose, "", `no exact ${purpose} workflow ref was configured`);
  const result = registry.resolve(requestedRef, projectID || undefined);
  if (!result.ok) {
    const diagnostics = [...new Set(result.diagnostics.map((item) => item.code))].join(", ") || "unavailable";
    return unavailableSelection(purpose, requestedRef, `Workflow Registry rejected ${requestedRef}: ${diagnostics}`);
  }
  return selectedWorkflow(purpose, requestedRef, result.resolution);
}

function selectedWorkflow(
  purpose: SupervisorPlanWorkflowPurpose,
  requestedRef: string,
  resolution: WorkflowResolution
): SupervisorPlanWorkflowSelection {
  return {
    approval_modes: resolution.manifest.stages.map((stage) => stage.approval.mode),
    manifest_ref: resolution.manifest_ref,
    project_override_applied: resolution.project_override_applied,
    ...(resolution.project_override_audit_ref
      ? { project_override_audit_ref: resolution.project_override_audit_ref }
      : {}),
    purpose,
    reason: `selected exact registered ${purpose} workflow revision`,
    requested_ref: requestedRef,
    source_path: resolution.source_path,
    status: "selected",
    verification_policy_refs: [...new Set(
      resolution.manifest.stages.map((stage) => stage.verification_policy_ref)
    )]
  };
}

function unavailableSelection(
  purpose: SupervisorPlanWorkflowPurpose,
  requestedRef: string,
  reason: string,
  status: "unavailable" | "not_required" = "unavailable"
): SupervisorPlanWorkflowSelection {
  return {
    approval_modes: [],
    project_override_applied: false,
    purpose,
    reason,
    requested_ref: requestedRef,
    status,
    verification_policy_refs: []
  };
}

function decomposeGoal(goal: string, route: SupervisorIntentRoute): PlannedStep[] {
  const explicit = explicitSteps(goal);
  const steps: PlannedStep[] = explicit.map((step) => ({
    goal: boundedText(step, 4096),
    purpose: releaseStep(step) ? "release" : "implement"
  }));
  const wantsExecute = route.intents.some((intent) => intent.kind === "execute");
  const wantsRelease = route.intents.some((intent) => intent.kind === "release");
  if (steps.length === 0) {
    steps.push({ goal, purpose: wantsRelease && !wantsExecute ? "release" : "implement" });
  }
  if (wantsExecute && !steps.some((step) => step.purpose === "implement")) {
    steps.unshift({ goal, purpose: "implement" });
  }
  if (wantsRelease && !steps.some((step) => step.purpose === "release")) {
    steps.push({
      goal: "执行经确定性权限门禁批准的发布交付，并记录目标、结果与回滚事实。",
      purpose: "release"
    });
  }
  return steps;
}

function explicitSteps(goal: string): string[] {
  const lines = goal.split(/\r?\n/).map((line) => cleanString(line));
  const listed = lines.flatMap((line) => {
    const match = /^(?:[-*]|\d+[.)、])\s*(.+)$/.exec(line);
    return match ? [cleanStep(match[1])] : [];
  }).filter(Boolean);
  if (listed.length >= 2) return listed;

  const withoutFirst = goal.replace(/^\s*(?:先|首先|first(?:ly)?)[：:,，]?\s*/i, "");
  const sequenced = withoutFirst.split(
    /\s*(?:，|,|；|;)?\s*(?:然后|接着|随后|最后|再|and then|then|finally)[：:,，]?\s*/i
  ).map(cleanStep).filter(Boolean);
  if (sequenced.length >= 2) return sequenced;
  const semicolon = goal.split(/[；;]/).map(cleanStep).filter(Boolean);
  return semicolon.length >= 2 ? semicolon : [];
}

function boundSteps(steps: PlannedStep[]): { reason: string; steps: PlannedStep[]; truncated: boolean } {
  const maxChildren = SUPERVISOR_PLAN_MAX_WORK_ITEMS - 1;
  if (steps.length <= maxChildren) {
    return {
      reason: `single-pass decomposition is bounded to depth ${SUPERVISOR_PLAN_MAX_DEPTH} and ${SUPERVISOR_PLAN_MAX_WORK_ITEMS} Work items`,
      steps,
      truncated: false
    };
  }
  const retained = steps.slice(0, maxChildren - 1);
  const remainder = steps.slice(maxChildren - 1);
  retained.push({
    goal: boundedText(`完成其余 ${remainder.length} 个有序步骤：${remainder.map((step) => step.goal).join("；")}`, 4096),
    purpose: remainder.some((step) => step.purpose === "release") ? "release" : "implement"
  });
  return {
    reason: `${steps.length} requested steps were collapsed into ${maxChildren} bounded child Work items without recursive decomposition`,
    steps: retained,
    truncated: true
  };
}

function plannedWorks(
  planDigest: string,
  projectID: string,
  goal: string,
  steps: PlannedStep[],
  selections: SupervisorPlanWorkflowSelection[]
): SupervisorPlannedWork[] {
  const selectionByPurpose = new Map(selections.map((selection) => [selection.purpose, selection]));
  if (steps.length === 1) {
    return [plannedWork({
      depth: 0,
      goal: steps[0].goal,
      id: planWorkID(planDigest, "step-1"),
      projectID,
      selection: requiredSelection(selectionByPurpose, steps[0].purpose),
      title: workTitle(steps[0].goal),
      type: "engineering_task"
    })];
  }

  const rootID = planWorkID(planDigest, "root");
  const firstSelection = requiredSelection(selectionByPurpose, steps[0]?.purpose ?? "implement");
  const root = plannedWork({
    depth: 0,
    goal,
    id: rootID,
    projectID,
    selection: firstSelection,
    title: workTitle(`交付：${goal}`),
    type: "objective"
  });
  const children = steps.map((step, index) => plannedWork({
    depth: 1,
    goal: step.goal,
    id: planWorkID(planDigest, `step-${index + 1}`),
    parentWorkID: rootID,
    projectID,
    selection: requiredSelection(selectionByPurpose, step.purpose),
    title: workTitle(step.goal),
    type: "engineering_task"
  }));
  return [root, ...children];
}

function plannedWork(input: {
  depth: number;
  goal: string;
  id: WorkID;
  parentWorkID?: WorkID;
  projectID: string;
  selection: SupervisorPlanWorkflowSelection;
  title: string;
  type: "objective" | "engineering_task";
}): SupervisorPlannedWork {
  return {
    acceptance: acceptanceFor(input.goal, input.selection, input.type),
    depth: input.depth,
    goal: boundedText(input.goal, 4096),
    id: input.id,
    owner: { kind: "project", project_id: input.projectID },
    ...(input.parentWorkID ? { parent_work_id: input.parentWorkID } : {}),
    status: "triage",
    title: input.title,
    type: input.type,
    workflow_ref: input.selection.manifest_ref!
  };
}

function acceptanceFor(
  goal: string,
  selection: SupervisorPlanWorkflowSelection,
  type: "objective" | "engineering_task"
): WorkAcceptanceContract {
  const refs = selection.verification_policy_refs;
  const firstRef = refs[0];
  if (!firstRef) throw new Error(`selected ${selection.purpose} workflow has no verification policy`);
  const finalRef = refs.at(-1) ?? firstRef;
  const criteria: WorkAcceptanceContract["criteria"] = [{
    description: type === "objective"
      ? "所有子 Work 按依赖顺序完成，并由当前 Workflow Verification Policy 复核。"
      : boundedText(`完成并可复核目标：${goal}`, 4096),
    id: "requested-outcome",
    required: true,
    verification_policy_ref: finalRef
  }, {
    description: "产生与本 Work 范围相称、可重新读取的 passed Evidence。",
    id: "focused-verification",
    required: true,
    verification_policy_ref: firstRef
  }];
  if (selection.purpose === "release") {
    criteria.push({
      description: "外部写操作具有确定性审批、目标、结果和回滚审计事实。",
      id: "release-audit",
      required: true,
      verification_policy_ref: finalRef
    });
  }
  return { completion_rule: "all_required", criteria, requires_handoff: true, version: 1 };
}

function sequentialDependencies(works: SupervisorPlannedWork[]): SupervisorWorkPlan["dependencies"] {
  const children = works.filter((work) => work.depth === 1);
  return children.slice(1).map((work, index) => ({
    depends_on_work_id: children[index].id,
    work_id: work.id
  }));
}

function buildApprovalPolicy(
  status: SupervisorWorkPlan["status"],
  mode: SupervisorWorkPlan["mode"],
  works: SupervisorPlannedWork[],
  selections: SupervisorPlanWorkflowSelection[]
): SupervisorWorkPlan["approval_policy"] {
  if (status !== "ready") {
    return {
      decision: "blocked",
      gate_authority: "deterministic_supervisor_plan_policy",
      materialization_permitted: false,
      reason: "plan cannot be approved until clarification and Workflow Registry resolution succeed",
      required: false,
      required_before: [],
      scope: "none"
    };
  }
  if (mode !== "work_plan") {
    return {
      decision: "not_required",
      gate_authority: "deterministic_supervisor_plan_policy",
      materialization_permitted: false,
      reason: "read-only or no-Work plan has no materialization approval",
      required: false,
      required_before: [],
      scope: "none"
    };
  }
  const modes = selections.flatMap((selection) => selection.approval_modes);
  const release = selections.some((selection) => selection.purpose === "release");
  const beforeStage = modes.includes("before_stage");
  const externalWrite = release || modes.includes("before_external_write");
  const decomposed = works.length > 1;
  const requiredBefore = [
    ...(decomposed ? ["plan_materialization" as const] : []),
    ...(beforeStage ? ["stage_execution" as const] : []),
    ...(externalWrite ? ["external_write" as const] : [])
  ];
  const scope = externalWrite ? "external_write" : beforeStage ? "stage_execution" : decomposed
    ? "plan_materialization" : "none";
  return {
    decision: requiredBefore.length > 0 ? "ask_user" : "not_required",
    gate_authority: "deterministic_supervisor_plan_policy",
    materialization_permitted: false,
    reason: requiredBefore.length > 0
      ? `explicit user approval is required before ${requiredBefore.join(", ")}`
      : "the explicit controlled-action request is sufficient to propose one triage Work; mutation gates still apply",
    required: requiredBefore.length > 0,
    required_before: requiredBefore,
    scope
  };
}

function planReason(
  status: SupervisorWorkPlan["status"],
  mode: SupervisorWorkPlan["mode"],
  clarification: string,
  selections: SupervisorPlanWorkflowSelection[]
): string {
  if (status === "needs_clarification") return clarification;
  if (status === "blocked") {
    return selections.filter((selection) => selection.status === "unavailable")
      .map((selection) => selection.reason).join("; ") || "Workflow selection is blocked";
  }
  if (mode === "read_only") return "bounded read-only investigation requires no Work mutation";
  if (mode === "no_work") return "intent controls or answers existing state and does not create new Work";
  return "goal was converted into a bounded Work graph with exact Workflow revisions and acceptance contracts";
}

function requiredSelection(
  selections: Map<SupervisorPlanWorkflowPurpose, SupervisorPlanWorkflowSelection>,
  purpose: SupervisorPlanWorkflowPurpose
): SupervisorPlanWorkflowSelection {
  const selection = selections.get(purpose);
  if (!selection || selection.status !== "selected") throw new Error(`missing selected ${purpose} workflow`);
  return selection;
}

function planWorkID(planDigest: string, suffix: string): WorkID {
  return `xw:work:supervisor_plan:${planDigest}-${suffix}`;
}

function approvalEvaluation(
  decision: SupervisorPlanApprovalEvaluation["decision"],
  satisfied: boolean,
  reasons: string[]
): SupervisorPlanApprovalEvaluation {
  return {
    decision,
    planner_precondition_satisfied: satisfied,
    reasons,
    tool_permission_granted: false
  };
}

function hasDirectedCycle(nodes: string[], edges: Array<[string, string]>): boolean {
  const adjacent = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const [from, to] of edges) adjacent.get(from)?.push(to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacent.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return nodes.some(visit);
}

function releaseStep(value: string): boolean {
  return /\b(?:deploy|publish|ship|release|rollout|testflight|app store)\b|(?:部署|发布|上线|上架|发版|提审|TestFlight)/i.test(value);
}

function workTitle(value: string): string {
  const clean = cleanStep(value).replace(/^#+\s*/, "");
  const runes = Array.from(clean);
  return runes.length <= 50 ? clean : `${runes.slice(0, 49).join("")}…`;
}

function cleanStep(value: string): string {
  return cleanString(value).replace(/[。.;；,，]+$/u, "");
}

function boundedText(value: unknown, max: number): string {
  const clean = cleanString(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
