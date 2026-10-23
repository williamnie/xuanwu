import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import {
  validateWorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  IMPLEMENT_CHANGE_POLICY,
  IMPLEMENT_STAGE_IDS,
  IMPLEMENT_TARGET_CONFIRMATION_POLICY,
  IMPLEMENT_VERIFICATION_POLICY,
  IMPLEMENT_WORKFLOW_MANIFEST,
  IMPLEMENT_WORKFLOW_REF,
  implementWorkflowRegistryContributions
} from "./implement.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");

describe("Implement Workflow", () => {
  test("registers and resolves the exact canonical Implement revision", () => {
    const fixtureManifest = JSON.parse(readFileSync(resolve(FIXTURES, "implement-workflow-v1.json"), "utf8"));
    expect(fixtureManifest).toEqual(IMPLEMENT_WORKFLOW_MANIFEST);
    expect(validateWorkflowManifest(IMPLEMENT_WORKFLOW_MANIFEST)).toEqual({ issues: [], ok: true });
    for (const policy of [
      IMPLEMENT_TARGET_CONFIRMATION_POLICY,
      IMPLEMENT_CHANGE_POLICY,
      IMPLEMENT_VERIFICATION_POLICY
    ]) expect(validateWorkflowVerificationPolicy(policy)).toEqual({ errors: [], ok: true });

    const registry = implementRegistry();

    expect(registry.diagnostics).toEqual([]);
    expect(registry.resolve(IMPLEMENT_WORKFLOW_REF)).toMatchObject({
      ok: true,
      resolution: { manifest: { id: "workflow:implement", revision: 1 } }
    });
  });

  test("freezes stage permissions and fails closed when the commit action is unavailable", () => {
    expect(IMPLEMENT_WORKFLOW_MANIFEST.stages.map((stage) => stage.id)).toEqual([...IMPLEMENT_STAGE_IDS]);
    expect(IMPLEMENT_WORKFLOW_MANIFEST.stages.at(-1)?.handoff).toEqual({
      mode: "branch_commit",
      project_override_modes: ["local_changes", "branch_commit"]
    });
    expect(IMPLEMENT_WORKFLOW_MANIFEST.stages.find((stage) => stage.id === "modify")).toMatchObject({
      approval: {
        mode: "before_stage",
        policy_ref: "approval-policy:implement-target-confirmed@1"
      },
      permissions: {
        allowed_actions: ["work.update"],
        max_tool_permission: "write"
      }
    });

    const contributions = implementWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: ["work.update"],
      manifests: contributions.manifests,
      skills: [],
      tools: listBuiltinAssistantTools(),
      verification_policies: contributions.verification_policies
    });
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({
      code: "missing_action",
      message: "allowed action missing: handoff.commit"
    }));
    expect(registry.resolve(IMPLEMENT_WORKFLOW_REF)).toMatchObject({ ok: false });
  });

  test("lets an audited project override choose local_changes but rejects remote Handoff expansion", () => {
    const contributions = implementWorkflowRegistryContributions();
    const projectOverride = {
      schema_version: "xuanwu.workflow-project-override.v1",
      project_id: "fixture-project",
      workflow_id: "workflow:implement",
      base_revision: 1,
      stage_overrides: [{ stage_id: "handoff", handoff_mode: "local_changes" }],
      verification_overrides: [],
      audit_event_ref: "pi_action_events:688:implement-handoff-mode"
    };
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: ["work.update", "handoff.commit"],
      manifests: contributions.manifests,
      project_overrides: [{ override: projectOverride, source_path: "project:fixture/implement.json" }],
      skills: [],
      tools: listBuiltinAssistantTools(),
      verification_policies: contributions.verification_policies
    });
    expect(registry.resolve(IMPLEMENT_WORKFLOW_REF, "fixture-project")).toMatchObject({
      ok: true,
      resolution: {
        manifest: { stages: expect.arrayContaining([expect.objectContaining({
          id: "handoff",
          handoff: expect.objectContaining({ mode: "local_changes" })
        })]) },
        project_override_applied: true,
        project_override_audit_ref: "pi_action_events:688:implement-handoff-mode"
      }
    });

    const widened = structuredClone(projectOverride);
    widened.stage_overrides[0]!.handoff_mode = "push";
    const blocked = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: ["work.update", "handoff.commit"],
      manifests: contributions.manifests,
      project_overrides: [{ override: widened, source_path: "project:fixture/implement-widened.json" }],
      skills: [],
      tools: listBuiltinAssistantTools(),
      verification_policies: contributions.verification_policies
    });
    expect(blocked.resolve(IMPLEMENT_WORKFLOW_REF, "fixture-project")).toMatchObject({ ok: false });
    expect(blocked.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid_project_override",
      message: "is not allowed by the base workflow"
    }));
  });
});

function implementRegistry() {
  const contributions = implementWorkflowRegistryContributions();
  return createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: ["work.update", "handoff.commit"],
    manifests: contributions.manifests,
    skills: [],
    tools: listBuiltinAssistantTools(),
    verification_policies: contributions.verification_policies
  });
}
