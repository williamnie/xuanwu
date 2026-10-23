import {
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

const RELEASE_WORKFLOW_SOURCE_PATH = "builtin:workflows/release@1" as const;
const RESEARCH_WORKFLOW_SOURCE_PATH = "builtin:workflows/research@1" as const;
const MIGRATE_WORKFLOW_SOURCE_PATH = "builtin:workflows/migrate@1" as const;

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
