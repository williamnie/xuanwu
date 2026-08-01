import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canSatisfyEvidenceGate,
  validateEvidence,
  type EvidenceRecord,
  type RunID,
  type WorkID
} from "../domain/evidence/contracts.ts";
import {
  evaluateWorkflowVerificationPolicy,
  type VerificationRiskLevel,
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import {
  validateHandoff,
  type HandoffRecord
} from "../domain/handoff/contracts.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

export const RELEASE_WORKFLOW_SOURCE_PATH = "builtin:workflows/release@1" as const;
export const RESEARCH_WORKFLOW_SOURCE_PATH = "builtin:workflows/research@1" as const;
export const MIGRATE_WORKFLOW_SOURCE_PATH = "builtin:workflows/migrate@1" as const;

export const RELEASE_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:release-readiness",
  revision: 1,
  name: "Release readiness and revision Evidence",
  kind_rules: [],
  required_groups: [{
    id: "release-readiness",
    operator: "all",
    requirements: [
      {
        id: "passed-release-check",
        evidence_kinds: ["test", "lint", "build"],
        scope: "run",
        fact_assertions: [{ key: "outcome", operator: "equals", expected: "passed" }],
        max_age_seconds: 24 * 60 * 60,
        artifact_policy: "ignore"
      },
      {
        id: "release-revision",
        evidence_kinds: ["git"],
        scope: "run",
        fact_assertions: [{ key: "revision", operator: "truthy" }],
        max_age_seconds: 24 * 60 * 60,
        artifact_policy: "ignore"
      }
    ]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const RESEARCH_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:research-source-evidence",
  revision: 1,
  name: "Research source Evidence",
  kind_rules: [],
  required_groups: [{
    id: "research-sources",
    operator: "all",
    requirements: [{
      id: "trusted-source-observation",
      evidence_kinds: ["http", "browser", "git", "shell"],
      scope: "work",
      fact_assertions: [{ key: "source_locator", operator: "truthy" }],
      max_age_seconds: 7 * 24 * 60 * 60,
      artifact_policy: "present"
    }]
  }],
  optional_requirements: [],
  risk_overrides: []
};

export const MIGRATE_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:migrate-contracts",
  revision: 1,
  name: "Migrate source and target contract Evidence",
  kind_rules: [],
  required_groups: [{
    id: "migration-contracts",
    operator: "all",
    requirements: [
      {
        id: "source-contract-snapshot",
        evidence_kinds: ["git", "shell"],
        scope: "run",
        selector_facts: { repository_role: "source" },
        fact_assertions: [{ key: "contract_digest", operator: "truthy" }],
        max_age_seconds: 24 * 60 * 60,
        artifact_policy: "ignore"
      },
      {
        id: "target-contract-verification",
        evidence_kinds: ["test", "git", "shell"],
        scope: "run",
        selector_facts: { repository_role: "target" },
        fact_assertions: [
          { key: "contract_digest", operator: "truthy" },
          { key: "outcome", operator: "equals", expected: "passed" }
        ],
        max_age_seconds: 24 * 60 * 60,
        artifact_policy: "ignore"
      }
    ]
  }],
  optional_requirements: [],
  risk_overrides: []
};

const readTools = [
  "runner-builtin:read",
  "runner-builtin:grep",
  "runner-builtin:find",
  "runner-builtin:ls",
  "runner-builtin:repo_tree",
  "runner-builtin:repo_search",
  "runner-builtin:repo_read_excerpt",
  "runner-builtin:work_read",
  "runner-builtin:run_read",
] as const;

export const RELEASE_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:release",
  revision: 1,
  name: "Release",
  description: "Freeze a verified revision, obtain an explicit checkpoint for external or destructive publication, publish through an audited integration receipt, verify, and retain an executable rollback in Handoff.",
  stages: [
    readStage("prepare", "Freeze revision, Evidence, Handoff, and rollback", "reporter", RELEASE_VERIFICATION_POLICY.id, "release"),
    {
      id: "publish",
      name: "Execute the approved release integration",
      agent: { role: "executor", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "dangerous",
        allowed_tools: [...readTools],
        allowed_actions: ["release.execute"]
      },
      verification_policy_ref: `${RELEASE_VERIFICATION_POLICY.id}@${RELEASE_VERIFICATION_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_external_write",
        policy_ref: "approval-policy:release-external-write@1"
      },
      handoff: { mode: "release", project_override_modes: ["deploy", "release"] }
    },
    readStage("verify", "Verify the published revision", "executor", RELEASE_VERIFICATION_POLICY.id, "release"),
    readStage("handoff", "Deliver release receipt and rollback", "reporter", RELEASE_VERIFICATION_POLICY.id, "release")
  ]
};

export const RESEARCH_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:research",
  revision: 1,
  name: "Research",
  description: "Bound the question, collect trusted source Evidence, map every claim to its sources, and deliver a read-only research Handoff.",
  stages: [
    researchStage("scope", "Bound the research question", "reporter"),
    researchStage("collect", "Collect source Evidence", "executor", ["http-readonly:url_fetch", "browser-readonly:read_page_context"]),
    researchStage("synthesize", "Synthesize only source-backed claims", "reviewer"),
    researchStage("handoff", "Deliver the cited research report", "reporter")
  ]
};

export const MIGRATE_WORKFLOW_MANIFEST: WorkflowManifest = {
  schema_version: "xuanwu.workflow-manifest.v1",
  id: "workflow:migrate",
  revision: 1,
  name: "Migrate",
  description: "Freeze source and target repository contracts, apply a bounded cross-repository migration only after approval, verify the target, and deliver an audited rollback-capable Handoff.",
  stages: [
    readStage("source-contract", "Freeze the source contract", "executor", MIGRATE_VERIFICATION_POLICY.id, "branch_commit"),
    readStage("target-contract", "Freeze the target contract and mapping", "executor", MIGRATE_VERIFICATION_POLICY.id, "branch_commit"),
    {
      id: "apply",
      name: "Apply the approved target migration",
      agent: { role: "executor", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [...readTools, "runner-builtin:work_update"],
        allowed_actions: ["migration.apply", "work.update"]
      },
      verification_policy_ref: `${MIGRATE_VERIFICATION_POLICY.id}@${MIGRATE_VERIFICATION_POLICY.revision}`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:migrate-target-write@1"
      },
      handoff: { mode: "branch_commit", project_override_modes: ["local_changes", "branch_commit"] }
    },
    readStage("verify", "Verify target contract parity", "executor", MIGRATE_VERIFICATION_POLICY.id, "branch_commit"),
    readStage("handoff", "Deliver target revision and rollback", "reporter", MIGRATE_VERIFICATION_POLICY.id, "branch_commit")
  ]
};

export const RELEASE_WORKFLOW_REF = workflowManifestRef(RELEASE_WORKFLOW_MANIFEST);
export const RESEARCH_WORKFLOW_REF = workflowManifestRef(RESEARCH_WORKFLOW_MANIFEST);
export const MIGRATE_WORKFLOW_REF = workflowManifestRef(MIGRATE_WORKFLOW_MANIFEST);

export function longRunningWorkflowRegistryContributions(): {
  manifests: WorkflowManifestRegistration[];
  verification_policies: WorkflowVerificationPolicy[];
} {
  return {
    manifests: [
      { manifest: structuredClone(RELEASE_WORKFLOW_MANIFEST), source_path: RELEASE_WORKFLOW_SOURCE_PATH },
      { manifest: structuredClone(RESEARCH_WORKFLOW_MANIFEST), source_path: RESEARCH_WORKFLOW_SOURCE_PATH },
      { manifest: structuredClone(MIGRATE_WORKFLOW_MANIFEST), source_path: MIGRATE_WORKFLOW_SOURCE_PATH }
    ],
    verification_policies: [
      structuredClone(RELEASE_VERIFICATION_POLICY),
      structuredClone(RESEARCH_VERIFICATION_POLICY),
      structuredClone(MIGRATE_VERIFICATION_POLICY)
    ]
  };
}

const requiredText = Type.String({ minLength: 1, maxLength: 8192 });
const timestamp = Type.String({ minLength: 20, maxLength: 35 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const workID = Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" });
const runID = Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+$" });
const evidenceID = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});
const handoffID = Type.String({ pattern: "^xw:handoff:derived:[A-Za-z0-9._~%-]+$" });
const identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" });

export const RESEARCH_WORKFLOW_REPORT_SCHEMA_VERSION = "xw.research-workflow-report.v1" as const;
export const RESEARCH_WORKFLOW_REPORT_SCHEMA = Type.Object({
  schema_version: Type.Literal(RESEARCH_WORKFLOW_REPORT_SCHEMA_VERSION),
  workflow_ref: Type.Literal(RESEARCH_WORKFLOW_REF),
  project_id: Type.String({ minLength: 1, maxLength: 256 }),
  work_id: workID,
  status: Type.Literal("completed"),
  question: requiredText,
  report_ref: requiredText,
  sources: Type.Array(Type.Object({
    id: identifier,
    kind: Type.Union([Type.Literal("url"), Type.Literal("repository"), Type.Literal("file")]),
    locator: requiredText,
    title: requiredText,
    retrieved_at: timestamp,
    evidence_id: evidenceID
  }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
  claims: Type.Array(Type.Object({
    id: identifier,
    statement: requiredText,
    source_ids: Type.Array(identifier, { minItems: 1, maxItems: 32 })
  }, { additionalProperties: false }), { minItems: 1, maxItems: 256 }),
  evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 256 }),
  handoff_id: handoffID,
  read_only_audit: Type.Object({
    confirmation: Type.Literal("no_source_or_external_state_mutation"),
    audit_event_refs: Type.Array(requiredText, { minItems: 1, maxItems: 256 }),
    state_mutations: Type.Array(requiredText, { maxItems: 0 }),
    external_writes: Type.Array(requiredText, { maxItems: 0 }),
    destructive_operations: Type.Array(requiredText, { maxItems: 0 })
  }, { additionalProperties: false })
}, { additionalProperties: false });

const migrationRepositorySchema = Type.Object({
  repository_ref: requiredText,
  revision: requiredText,
  contract_ref: requiredText,
  contract_digest: digest
}, { additionalProperties: false });

const authorizedMutationSchema = Type.Object({
  action: Type.Literal("migration.apply"),
  classification: Type.Literal("external_write"),
  target: requiredText,
  outcome: Type.Literal("succeeded"),
  authorization: Type.Object({
    authority: Type.Literal("human_approval"),
    decision: Type.Literal("allow"),
    policy_ref: requiredText,
    audit_event_ref: requiredText
  }, { additionalProperties: false }),
  audit_event_ref: requiredText,
  before_ref: requiredText,
  after_ref: requiredText,
  rollback_ref: requiredText
}, { additionalProperties: false });

export const MIGRATE_WORKFLOW_EXECUTION_SCHEMA_VERSION = "xw.migrate-workflow-execution.v1" as const;
export const MIGRATE_WORKFLOW_EXECUTION_SCHEMA = Type.Object({
  schema_version: Type.Literal(MIGRATE_WORKFLOW_EXECUTION_SCHEMA_VERSION),
  workflow_ref: Type.Literal(MIGRATE_WORKFLOW_REF),
  project_id: Type.String({ minLength: 1, maxLength: 256 }),
  work_id: workID,
  run_id: runID,
  status: Type.Literal("completed"),
  source: migrationRepositorySchema,
  target: Type.Object({
    repository_ref: requiredText,
    baseline_revision: requiredText,
    revision: requiredText,
    contract_ref: requiredText,
    contract_digest: digest
  }, { additionalProperties: false }),
  mappings: Type.Array(Type.Object({
    source_path: requiredText,
    target_path: requiredText,
    adapter_ref: Type.Optional(requiredText)
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4096 }),
  authority: Type.Object({
    source_of_truth: Type.Literal("source_repository"),
    target_role: Type.Literal("derived_until_cutover"),
    dual_write: Type.Literal("disabled"),
    dual_read: Type.Literal("bounded_validation_only"),
    deletion_gate_ref: requiredText
  }, { additionalProperties: false }),
  evidence_ids: Type.Array(evidenceID, { minItems: 2, maxItems: 256 }),
  source_evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 128 }),
  target_evidence_ids: Type.Array(evidenceID, { minItems: 1, maxItems: 128 }),
  mutation: authorizedMutationSchema,
  rollback: Type.Object({
    plan: requiredText,
    checkpoint_ref: requiredText,
    destructive: Type.Literal(false)
  }, { additionalProperties: false }),
  handoff_id: handoffID
}, { additionalProperties: false });

export type ResearchWorkflowReport = Static<typeof RESEARCH_WORKFLOW_REPORT_SCHEMA>;
export type MigrateWorkflowExecution = Static<typeof MIGRATE_WORKFLOW_EXECUTION_SCHEMA>;
export type WorkflowRuntimeContext = {
  evidence: readonly EvidenceRecord[];
  handoff: HandoffRecord;
  now: string;
  runs: Array<{ id: RunID; work_id: WorkID }>;
};
export type WorkflowValidation = { errors: string[]; ok: boolean };

export type ReleaseWorkflowProjection = {
  evidence_ids: string[];
  handoff_id: HandoffRecord["id"];
  release_ref: string;
  revision_ref: string;
  rollback: HandoffRecord["rollback"];
  status: "released";
  version: string;
  workflow_ref: typeof RELEASE_WORKFLOW_REF;
  work_id: HandoffRecord["work_id"];
};

export function completeReleaseWorkflow(input: {
  project_id: string;
  run_id: RunID;
  context: WorkflowRuntimeContext;
}): ReleaseWorkflowProjection {
  const { context } = input;
  const errors = validateRuntimeHandoff(context);
  const handoff = context.handoff;
  if (handoff.delivery.mode !== "release") errors.push("Release Workflow requires release Handoff delivery");
  if (handoff.status !== "delivered") errors.push("Release Workflow completion requires a delivered Handoff");
  if (!handoff.run_ids.includes(input.run_id)) errors.push("Release Run is absent from Handoff");
  const evaluation = evaluatePolicy(
    RELEASE_VERIFICATION_POLICY,
    input.project_id,
    handoff.work_id,
    input.run_id,
    context.now,
    context.evidence,
    "high"
  );
  if (!evaluation.satisfied) errors.push(`release Evidence policy did not pass: ${evaluation.decision}`);
  for (const id of evaluationEvidenceIDs(evaluation)) {
    if (!handoff.evidence_ids.includes(id as HandoffRecord["evidence_ids"][number])) {
      errors.push(`release policy Evidence ${id} is absent from Handoff`);
    }
  }
  if (!context.evidence.some((item) =>
    handoff.evidence_ids.includes(item.id) && item.kind === "git" &&
    item.decisive_output.facts.revision === handoff.final_revision
  )) {
    errors.push("Release Handoff revision does not match trusted Git Evidence");
  }
  const releaseAction = handoff.delivery_actions.find((action) => action.action === "release" && action.required);
  if (!releaseAction) errors.push("Release Handoff requires a required release action");
  else {
    if (releaseAction.outcome !== "succeeded") errors.push("Release action must have a succeeded receipt");
    if (releaseAction.classification === "destructive" && releaseAction.gate.authority !== "human_approval") {
      errors.push("destructive release action requires human approval");
    }
  }
  for (const action of handoff.delivery_actions.filter((item) => item.classification === "destructive")) {
    if (action.gate.authority !== "human_approval" || action.gate_decision !== "allow") {
      errors.push(`destructive ${action.action} cannot execute without human approval`);
    }
  }
  if (handoff.rollback.availability !== "available" || !handoff.rollback.plan?.trim() || handoff.rollback.refs.length === 0) {
    errors.push("Release Workflow requires an available, referenced rollback plan");
  }
  throwIfErrors("Release Workflow", errors);
  if (handoff.delivery.mode !== "release") throw new Error("unreachable release delivery");
  return {
    evidence_ids: [...handoff.evidence_ids],
    handoff_id: handoff.id,
    release_ref: handoff.delivery.release_ref,
    revision_ref: handoff.delivery.revision_ref,
    rollback: structuredClone(handoff.rollback),
    status: "released",
    version: handoff.delivery.version,
    workflow_ref: RELEASE_WORKFLOW_REF,
    work_id: handoff.work_id
  };
}

export function validateResearchWorkflowReport(
  input: unknown,
  context: WorkflowRuntimeContext
): WorkflowValidation {
  const schemaErrors = schemaValidationErrors(RESEARCH_WORKFLOW_REPORT_SCHEMA, input);
  if (schemaErrors.length > 0) return { errors: schemaErrors, ok: false };
  const report = input as ResearchWorkflowReport;
  const errors = validateRuntimeHandoff(context);
  unique(report.sources.map((source) => source.id), "research source ids", errors);
  unique(report.claims.map((claim) => claim.id), "research claim ids", errors);
  unique(report.evidence_ids, "research Evidence ids", errors);
  unique(report.read_only_audit.audit_event_refs, "research audit refs", errors);
  if (context.handoff.id !== report.handoff_id || context.handoff.work_id !== report.work_id) {
    errors.push("Research report Handoff does not match its Work");
  }
  if (context.handoff.delivery.mode !== "local_changes" ||
      !context.handoff.changed_files.includes(report.report_ref)) {
    errors.push("Research Handoff must deliver the report as a local changed artifact");
  }
  const declared = new Set(report.evidence_ids);
  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  for (const source of report.sources) {
    if (!isIsoTimestamp(source.retrieved_at)) errors.push(`research source ${source.id} retrieved_at is invalid`);
    if (!declared.has(source.evidence_id)) errors.push(`research source ${source.id} references undeclared Evidence`);
    const item = evidence.get(source.evidence_id as EvidenceRecord["id"]);
    if (!item || !trustedEvidence(item, report.work_id as WorkID)) {
      errors.push(`research source ${source.id} requires passed trusted Evidence`);
      continue;
    }
    if (!researchKindMatches(source.kind, item.kind)) {
      errors.push(`research source ${source.id} Evidence kind ${item.kind} does not match ${source.kind}`);
    }
    if (item.decisive_output.facts.source_locator !== source.locator) {
      errors.push(`research source ${source.id} Evidence locator does not match`);
    }
    if (!item.artifact_refs.some((artifact) => artifact.ref === source.locator)) {
      errors.push(`research source ${source.id} locator is not preserved as an Evidence artifact`);
    }
  }
  const citedSources = new Set<string>();
  for (const claim of report.claims) {
    unique(claim.source_ids, `research claim ${claim.id} source ids`, errors);
    for (const sourceID of claim.source_ids) {
      if (!sources.has(sourceID)) errors.push(`research claim ${claim.id} references unknown source ${sourceID}`);
      else citedSources.add(sourceID);
    }
  }
  for (const source of report.sources) {
    if (!citedSources.has(source.id)) errors.push(`research source ${source.id} is not cited by any claim`);
  }
  for (const id of declared) {
    if (!report.sources.some((source) => source.evidence_id === id)) {
      errors.push(`research Evidence ${id} is not linked to a source`);
    }
    if (!context.handoff.evidence_ids.includes(id as HandoffRecord["evidence_ids"][number])) {
      errors.push(`research Evidence ${id} is absent from Handoff`);
    }
  }
  const evaluation = evaluatePolicy(
    RESEARCH_VERIFICATION_POLICY,
    report.project_id,
    report.work_id as WorkID,
    undefined,
    context.now,
    context.evidence,
    "safe"
  );
  if (!evaluation.satisfied) errors.push(`research Evidence policy did not pass: ${evaluation.decision}`);
  return result(errors);
}

export function validateMigrateWorkflowExecution(
  input: unknown,
  context: WorkflowRuntimeContext
): WorkflowValidation {
  const schemaErrors = schemaValidationErrors(MIGRATE_WORKFLOW_EXECUTION_SCHEMA, input);
  if (schemaErrors.length > 0) return { errors: schemaErrors, ok: false };
  const execution = input as MigrateWorkflowExecution;
  const errors = validateRuntimeHandoff(context);
  if (execution.source.repository_ref === execution.target.repository_ref) {
    errors.push("Migrate Workflow requires distinct source and target repositories");
  }
  unique(execution.evidence_ids, "migration Evidence ids", errors);
  unique(execution.source_evidence_ids, "migration source Evidence ids", errors);
  unique(execution.target_evidence_ids, "migration target Evidence ids", errors);
  unique(execution.mappings.map((item) => item.source_path), "migration source paths", errors);
  unique(execution.mappings.map((item) => item.target_path), "migration target paths", errors);
  const declared = new Set(execution.evidence_ids);
  const roleIDs = [...execution.source_evidence_ids, ...execution.target_evidence_ids];
  unique(roleIDs, "migration role Evidence ids", errors);
  for (const id of roleIDs) if (!declared.has(id)) errors.push(`migration role references undeclared Evidence ${id}`);
  for (const id of declared) if (!roleIDs.includes(id)) errors.push(`migration Evidence ${id} has no source or target role`);

  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  validateMigrationEvidence(
    execution.source_evidence_ids,
    "source",
    execution.source.contract_digest,
    execution.work_id as WorkID,
    execution.run_id as RunID,
    evidence,
    errors
  );
  validateMigrationEvidence(
    execution.target_evidence_ids,
    "target",
    execution.target.contract_digest,
    execution.work_id as WorkID,
    execution.run_id as RunID,
    evidence,
    errors
  );
  if (execution.mutation.target !== execution.target.repository_ref ||
      execution.mutation.before_ref !== execution.target.baseline_revision ||
      execution.mutation.after_ref !== execution.target.revision ||
      execution.mutation.rollback_ref !== execution.rollback.checkpoint_ref) {
    errors.push("migration mutation receipt does not match target or rollback checkpoint");
  }
  if (context.handoff.id !== execution.handoff_id || context.handoff.work_id !== execution.work_id) {
    errors.push("migration Handoff does not match its Work");
  }
  if (!context.handoff.run_ids.includes(execution.run_id as RunID)) {
    errors.push("migration Run is absent from Handoff");
  }
  if (context.handoff.delivery.mode !== "branch_commit" ||
      context.handoff.delivery.commit_ref !== execution.target.revision ||
      context.handoff.final_revision !== execution.target.revision) {
    errors.push("migration Handoff must deliver the exact target revision");
  }
  for (const mapping of execution.mappings) {
    if (!context.handoff.changed_files.includes(mapping.target_path)) {
      errors.push(`migration target path ${mapping.target_path} is absent from Handoff`);
    }
  }
  for (const id of declared) {
    if (!context.handoff.evidence_ids.includes(id as HandoffRecord["evidence_ids"][number])) {
      errors.push(`migration Evidence ${id} is absent from Handoff`);
    }
  }
  if (context.handoff.rollback.availability !== "available" ||
      !context.handoff.rollback.refs.includes(execution.rollback.checkpoint_ref)) {
    errors.push("migration Handoff must retain the execution rollback checkpoint");
  }
  const evaluation = evaluatePolicy(
    MIGRATE_VERIFICATION_POLICY,
    execution.project_id,
    execution.work_id as WorkID,
    execution.run_id as RunID,
    context.now,
    context.evidence,
    "confirm"
  );
  if (!evaluation.satisfied) errors.push(`migration Evidence policy did not pass: ${evaluation.decision}`);
  for (const id of evaluationEvidenceIDs(evaluation)) {
    if (!declared.has(id)) errors.push(`migration policy Evidence ${id} is not declared by the execution`);
  }
  return result(errors);
}

function readStage(
  id: string,
  name: string,
  role: "reporter" | "executor",
  policyID: string,
  handoffMode: "release" | "branch_commit"
): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role, required_skill_ids: [] },
    permissions: { max_tool_permission: "read", allowed_tools: [...readTools], allowed_actions: [] },
    verification_policy_ref: `${policyID}@1`,
    retry: { max_attempts: 1, backoff_seconds: [] },
    approval: { mode: "none" },
    handoff: {
      mode: handoffMode,
      project_override_modes: handoffMode === "release" ? ["deploy", "release"] : ["local_changes", "branch_commit"]
    }
  };
}

function researchStage(
  id: string,
  name: string,
  role: "reporter" | "reviewer" | "executor",
  extraTools: readonly string[] = []
): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role, required_skill_ids: [] },
    permissions: {
      max_tool_permission: "read",
      allowed_tools: [...new Set([...readTools, ...extraTools])],
      allowed_actions: []
    },
    verification_policy_ref: `${RESEARCH_VERIFICATION_POLICY.id}@${RESEARCH_VERIFICATION_POLICY.revision}`,
    retry: { max_attempts: 1, backoff_seconds: [] },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
  };
}

function validateRuntimeHandoff(context: WorkflowRuntimeContext): string[] {
  const validation = validateHandoff(context.handoff, {
    evidence: context.evidence.map((item) => ({ id: item.id, status: item.status, work_id: item.work_id })),
    runs: context.runs
  });
  return [...validation.errors];
}

function evaluatePolicy(
  policy: WorkflowVerificationPolicy,
  projectID: string,
  workIDValue: WorkID,
  runIDValue: RunID | undefined,
  now: string,
  evidence: readonly EvidenceRecord[],
  risk: VerificationRiskLevel
) {
  return evaluateWorkflowVerificationPolicy({
    context: {
      now,
      project_id: projectID,
      risk,
      ...(runIDValue ? { run_id: runIDValue } : {}),
      work_id: workIDValue
    },
    evidence,
    policy
  });
}

function validateMigrationEvidence(
  ids: readonly string[],
  role: "source" | "target",
  contractDigest: string,
  workIDValue: WorkID,
  runIDValue: RunID,
  evidence: ReadonlyMap<EvidenceRecord["id"], EvidenceRecord>,
  errors: string[]
): void {
  for (const id of ids) {
    const item = evidence.get(id as EvidenceRecord["id"]);
    if (!item || !trustedEvidence(item, workIDValue)) {
      errors.push(`migration ${role} Evidence ${id} is missing or untrusted`);
      continue;
    }
    if (item.run_id !== runIDValue) errors.push(`migration ${role} Evidence ${id} belongs to another Run`);
    const allowedKinds = role === "source" ? ["git", "shell"] : ["test", "git", "shell"];
    if (!allowedKinds.includes(item.kind)) errors.push(`migration ${role} Evidence ${id} has unsupported kind ${item.kind}`);
    if (item.decisive_output.facts.repository_role !== role) {
      errors.push(`migration ${role} Evidence ${id} has the wrong repository role`);
    }
    if (item.decisive_output.facts.contract_digest !== contractDigest) {
      errors.push(`migration ${role} Evidence ${id} contract digest does not match`);
    }
    if (role === "target" && item.decisive_output.facts.outcome !== "passed") {
      errors.push(`migration target Evidence ${id} does not record outcome=passed`);
    }
  }
}

function evaluationEvidenceIDs(
  evaluation: ReturnType<typeof evaluateWorkflowVerificationPolicy>
): string[] {
  return evaluation.groups.flatMap((group) =>
    group.requirements.flatMap((requirement) => requirement.evidence_id ? [requirement.evidence_id] : [])
  );
}

function trustedEvidence(evidence: EvidenceRecord, workIDValue: WorkID): boolean {
  return evidence.work_id === workIDValue && validateEvidence(evidence).ok && canSatisfyEvidenceGate(evidence);
}

function researchKindMatches(sourceKind: ResearchWorkflowReport["sources"][number]["kind"], evidenceKind: string): boolean {
  if (sourceKind === "url") return evidenceKind === "http" || evidenceKind === "browser";
  if (sourceKind === "repository") return evidenceKind === "git" || evidenceKind === "shell";
  return evidenceKind === "shell" || evidenceKind === "git";
}

function schemaValidationErrors(schema: Parameters<typeof Value.Check>[0], input: unknown): string[] {
  if (Value.Check(schema, input)) return [];
  return [...Value.Errors(schema, input)].map((error) => `schema ${error.path || "/"}: ${error.message}`);
}

function unique(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} must be unique`);
}

function result(errors: string[]): WorkflowValidation {
  const uniqueErrors = [...new Set(errors)];
  return { errors: uniqueErrors, ok: uniqueErrors.length === 0 };
}

function throwIfErrors(label: string, errors: string[]): void {
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) throw new Error(`${label}: ${uniqueErrors.join("; ")}`);
}

function isIsoTimestamp(value: string): boolean {
  if (!Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
