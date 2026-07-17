import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import type {
  ReviewerFinding,
  ReviewerLoopResult
} from "../domain/handoff/reviewerLoop.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";
import { REPAIR_WORKFLOW_REF } from "./repair.ts";

export const REVIEW_WORKFLOW_SOURCE_PATH = "builtin:workflows/review@1" as const;
export const REVIEW_WORKFLOW_PROJECTION_SCHEMA_VERSION = "xw.review-workflow-projection.v1" as const;
export const REVIEW_STAGE_IDS = [
  "scope",
  "inspect",
  "decide",
  "handoff-replan"
] as const;
export const REVIEW_WORKFLOW_ACTIONS = [
  "handoff.review_decide",
  "handoff.repair_schedule"
] as const;
export type ReviewStageID = typeof REVIEW_STAGE_IDS[number];

export const REVIEW_EVIDENCE_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:review-evidence",
  revision: 1,
  name: "Review findings backed by current Evidence",
  kind_rules: [],
  required_groups: [{
    id: "review-input",
    operator: "all",
    requirements: [{
      id: "trusted-review-input",
      evidence_kinds: ["shell", "test", "lint", "build", "git", "http", "browser"],
      scope: "work",
      fact_assertions: [],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const REVIEW_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:review",
  revision: 1,
  name: "Review",
  description: "Inspect code and Evidence without modifying the workspace, authorize structured findings through Reviewer Loop, and either accept the Handoff or request an audited Repair replan.",
  stages: [
    readStage("scope", "Freeze the Handoff, acceptance criteria, and Evidence input", "reporter"),
    readStage("inspect", "Perform read-only code and Evidence review", "reviewer"),
    {
      id: "decide",
      name: "Authorize accept, request_changes, or reject",
      agent: { role: "reviewer", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [
          "runner-builtin:work_read",
          "runner-builtin:run_read",
          "runner-builtin:evidence_list",
          "runner-builtin:evidence_read",
          "runner-builtin:handoff_read"
        ],
        allowed_actions: ["handoff.review_decide"]
      },
      verification_policy_ref: `${REVIEW_EVIDENCE_POLICY.id}@${REVIEW_EVIDENCE_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:reviewer-decision-gate@1"
      },
      handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
    },
    {
      id: "handoff-replan",
      name: "Accept the Handoff or schedule the bounded Repair loop",
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
        allowed_actions: ["handoff.repair_schedule"]
      },
      verification_policy_ref: `${REVIEW_EVIDENCE_POLICY.id}@${REVIEW_EVIDENCE_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:reviewer-repair-budget@1"
      },
      handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
    }
  ]
};

export const REVIEW_WORKFLOW_REF = workflowManifestRef(REVIEW_WORKFLOW_MANIFEST);

export type ReviewWorkflowFinding = ReviewerFinding & {
  action: ReviewerLoopResult["cycles"][number]["action"];
  cycle: number;
  decision_ref: string;
  handoff_id: ReviewerLoopResult["handoff"]["id"];
};

export type ReviewWorkflowProjection = {
  evidence_ids: string[];
  findings: ReviewWorkflowFinding[];
  handoff: {
    id: ReviewerLoopResult["handoff"]["id"];
    review_state: ReviewerLoopResult["handoff"]["review"]["state"];
    status: ReviewerLoopResult["handoff"]["status"];
  };
  outcome: ReviewerLoopResult["status"];
  repair_run_ids: string[];
  replan: null | {
    decision_ref: string;
    finding_ids: string[];
    reason: string;
    required: true;
    suggested_workflow_ref: typeof REPAIR_WORKFLOW_REF;
  };
  schema_version: typeof REVIEW_WORKFLOW_PROJECTION_SCHEMA_VERSION;
  workflow_ref: typeof REVIEW_WORKFLOW_REF;
};

export function reviewWorkflowRegistryContributions(): {
  manifests: WorkflowManifestRegistration[];
  verification_policies: WorkflowVerificationPolicy[];
} {
  return {
    manifests: [{
      manifest: structuredClone(REVIEW_WORKFLOW_MANIFEST),
      source_path: REVIEW_WORKFLOW_SOURCE_PATH
    }],
    verification_policies: [structuredClone(REVIEW_EVIDENCE_POLICY)]
  };
}

export function projectReviewWorkflowOutcome(result: ReviewerLoopResult): ReviewWorkflowProjection {
  validateReviewerLoopResult(result);
  const last = result.cycles.at(-1)!;
  const findings = result.cycles.flatMap((cycle) => cycle.findings.map((finding) => ({
    ...copyFinding(finding),
    action: cycle.action,
    cycle: cycle.cycle,
    decision_ref: cycle.decision_ref,
    handoff_id: cycle.handoff_id
  })));
  const replan = result.status === "accepted" ? null : {
    decision_ref: last.decision_ref,
    finding_ids: last.findings.map((finding) => finding.finding_id),
    reason: result.status === "budget_exhausted"
      ? "review cycle budget exhausted; automatic repair must stop and the next Repair Work requires explicit replanning"
      : "review rejected the current Handoff; create a bounded Repair Work only after current authority approves the replan",
    required: true as const,
    suggested_workflow_ref: REPAIR_WORKFLOW_REF
  };
  return {
    evidence_ids: [...result.handoff.evidence_ids],
    findings,
    handoff: {
      id: result.handoff.id,
      review_state: result.handoff.review.state,
      status: result.handoff.status
    },
    outcome: result.status,
    repair_run_ids: result.repair_relations.map((relation) => relation.run_id),
    replan,
    schema_version: REVIEW_WORKFLOW_PROJECTION_SCHEMA_VERSION,
    workflow_ref: REVIEW_WORKFLOW_REF
  };
}

function readStage(
  id: Extract<ReviewStageID, "scope" | "inspect">,
  name: string,
  role: "reporter" | "reviewer"
): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role, required_skill_ids: [] },
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
        "runner-builtin:evidence_read",
        "runner-builtin:handoff_read"
      ],
      allowed_actions: []
    },
    verification_policy_ref: `${REVIEW_EVIDENCE_POLICY.id}@${REVIEW_EVIDENCE_POLICY.revision}`,
    retry: { max_attempts: 1, backoff_seconds: [] },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", required: true, project_override_modes: ["local_changes"] }
  };
}

function validateReviewerLoopResult(result: ReviewerLoopResult): void {
  if (result.cycles.length === 0) throw new Error("Review Workflow requires at least one Reviewer Loop cycle");
  if (result.evidence_history.length !== result.cycles.length) {
    throw new Error("Review Workflow Evidence history does not match cycle history");
  }
  const relationRunIDs = result.repair_relations.map((relation) => relation.run_id);
  if (new Set(relationRunIDs).size !== relationRunIDs.length) {
    throw new Error("Review Workflow repair Run ids must be unique");
  }
  for (const [index, cycle] of result.cycles.entries()) {
    if (cycle.cycle !== index + 1) throw new Error("Review Workflow cycles must be consecutive and one-based");
    requiredText(cycle.decision_ref, "Review decision_ref");
    requiredText(cycle.authorization_ref, "Review authorization_ref");
    requiredText(cycle.policy_ref, "Review policy_ref");
    if (cycle.findings.length === 0) throw new Error(`Review cycle ${cycle.cycle} requires findings`);
    if (new Set(cycle.findings.map((finding) => finding.finding_id)).size !== cycle.findings.length) {
      throw new Error(`Review cycle ${cycle.cycle} finding ids must be unique`);
    }
    const evidenceIDs = new Set<string>(cycle.evidence_ids);
    for (const finding of cycle.findings) {
      for (const evidenceID of finding.evidence_ids) {
        if (!evidenceIDs.has(evidenceID)) {
          throw new Error(`Review finding ${finding.finding_id} references Evidence outside its cycle`);
        }
      }
    }
    for (const evidenceID of cycle.fresh_evidence_ids) {
      if (!evidenceIDs.has(evidenceID)) throw new Error(`Review cycle ${cycle.cycle} fresh Evidence is not linked`);
    }
    const previous = result.cycles[index - 1];
    if (previous?.action === "request_changes") {
      if (cycle.handoff_id === previous.handoff_id) {
        throw new Error(`Review cycle ${cycle.cycle} must use the repaired Handoff`);
      }
      if (cycle.fresh_evidence_ids.length === 0) {
        throw new Error(`Review cycle ${cycle.cycle} requires fresh Repair Evidence`);
      }
      for (const evidenceID of previous.evidence_ids) {
        if (!evidenceIDs.has(evidenceID)) {
          throw new Error(`Review cycle ${cycle.cycle} dropped prior Evidence ${evidenceID}`);
        }
      }
    }
    validateActionFindings(cycle.action, cycle.findings, cycle.cycle);
    validateEvidenceHistory(result, index);
  }

  const last = result.cycles.at(-1)!;
  if (result.status === "accepted") {
    if (last.action !== "accept") throw new Error("accepted Review Workflow requires a final accept decision");
    if (result.handoff.review.state !== "approved") {
      throw new Error("accepted Review Workflow requires an approved Handoff projection");
    }
  } else if (result.status === "rejected") {
    if (last.action !== "reject") throw new Error("rejected Review Workflow requires a final reject decision");
  } else if (last.action !== "request_changes") {
    throw new Error("budget-exhausted Review Workflow requires a final request_changes decision");
  }

  const expectedRepairs = result.cycles.slice(0, -1)
    .filter((cycle) => cycle.action === "request_changes").length;
  if (result.repair_relations.length !== expectedRepairs) {
    throw new Error("Review Workflow repair Run history does not match request_changes cycles");
  }
  const lastHistory = result.evidence_history.at(-1)!;
  if (result.handoff.id !== last.handoff_id) {
    throw new Error("Review Workflow final Handoff does not match the last cycle");
  }
  if (!sameStrings(lastHistory.evidence_ids, result.handoff.evidence_ids)) {
    throw new Error("Review Workflow final Evidence history does not match the Handoff");
  }
}

function validateEvidenceHistory(result: ReviewerLoopResult, index: number): void {
  const cycle = result.cycles[index]!;
  const history = result.evidence_history[index]!;
  if (history.action !== cycle.action || history.cycle !== cycle.cycle ||
      history.decision_ref !== cycle.decision_ref || history.handoff_id !== cycle.handoff_id ||
      !sameStrings(history.evidence_ids, cycle.evidence_ids) ||
      JSON.stringify(history.findings) !== JSON.stringify(cycle.findings)) {
    throw new Error(`Review Workflow Evidence history diverges at cycle ${cycle.cycle}`);
  }
}

function validateActionFindings(
  action: ReviewerLoopResult["cycles"][number]["action"],
  findings: readonly ReviewerFinding[],
  cycle: number
): void {
  const results = findings.map((finding) => finding.result);
  if (action === "accept" && results.some((result) => result !== "pass")) {
    throw new Error(`Review cycle ${cycle} accept requires passing findings`);
  }
  if (action === "reject" && !results.includes("fail")) {
    throw new Error(`Review cycle ${cycle} reject requires a failing finding`);
  }
  if (action === "request_changes" && results.every((result) => result === "pass")) {
    throw new Error(`Review cycle ${cycle} request_changes requires a non-passing finding`);
  }
}

function copyFinding(finding: ReviewerFinding): ReviewerFinding {
  return {
    ...finding,
    acceptance_criterion_ids: [...finding.acceptance_criterion_ids],
    evidence_ids: [...finding.evidence_ids]
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} is required`);
  return normalized;
}
