import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import {
  workflowManifestRef,
  type WorkflowManifest
} from "./manifest.ts";
import type { WorkflowManifestRegistration } from "./registry.ts";

const IMPLEMENT_WORKFLOW_SOURCE_PATH = "builtin:workflows/implement@1" as const;
export const IMPLEMENT_STAGE_IDS = [
  "confirm-target",
  "modify",
  "focused-verify",
  "regression",
  "handoff"
] as const;

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
  description: "Confirm the target, modify scoped files, run focused verification and regression, then report the resulting workspace state. An optional Handoff may be produced for delivery.",
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
          "runner-builtin:issue_read",
          "runner-builtin:issue_execution_status"
        ],
        allowed_actions: []
      },
      verification_policy_ref: "verification-policy:implement-target-confirmation@1",
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: { mode: "none" },
      handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
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
        ],
        allowed_actions: ["work.update"]
      },
      verification_policy_ref: "verification-policy:implement-change-snapshot@1",
      retry: { max_attempts: 2, backoff_seconds: [5] },
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:implement-target-confirmed@1"
      },
      handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
    },
    verificationStage("focused-verify", "Run focused verification"),
    verificationStage("regression", "Run related regression"),
    {
      id: "handoff",
      name: "Report the resulting workspace state",
      agent: { role: "reporter", required_skill_ids: [] },
      permissions: {
        max_tool_permission: "write",
        allowed_tools: [
          "runner-builtin:work_read",
          "runner-builtin:run_read",
        ],
        allowed_actions: ["handoff.commit"]
      },
      verification_policy_ref: "verification-policy:implement-command-verification@1",
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: { mode: "none" },
      handoff: {
        mode: "branch_commit",
        project_override_modes: ["local_changes", "branch_commit"]
      }
    }
  ]
};

export const IMPLEMENT_WORKFLOW_REF = workflowManifestRef(IMPLEMENT_WORKFLOW_MANIFEST);
const stageID = Type.Union(IMPLEMENT_STAGE_IDS.map((id) => Type.Literal(id)));
const stageTarget = Type.Union([...IMPLEMENT_STAGE_IDS.map((id) => Type.Literal(id)), Type.Literal("completed")]);

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

function verificationStage(id: "focused-verify" | "regression", name: string): WorkflowManifest["stages"][number] {
  return {
    id,
    name,
    agent: { role: "executor", required_skill_ids: [] },
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
      ],
      allowed_actions: []
    },
    verification_policy_ref: "verification-policy:implement-command-verification@1",
    retry: { max_attempts: 2, backoff_seconds: [5] },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", project_override_modes: ["local_changes"] }
  };
}
