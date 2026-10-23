import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
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
  evaluateImplementStageTransition,
  implementWorkflowRegistryContributions,
  validateImplementWorkflowRun,
  type ImplementWorkflowRun,
  type ImplementWorkflowValidationContext
} from "./implement.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0055-implement-workflow.md");

type ImplementFixture = ImplementWorkflowValidationContext & {
  evidence: EvidenceRecord[];
  handoff: HandoffRecord;
  name: "local_changes" | "branch_commit";
  receipt: ImplementWorkflowRun;
};

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

  test("allows only audited forward or verification-rework stage transitions", () => {
    const fixture = implementFixtures()[0]!;
    for (const transition of fixture.receipt.transitions) {
      expect(evaluateImplementStageTransition(transition)).toEqual({ allowed: true, violations: [] });
    }

    const focused = fixture.receipt.transitions.find((item) => item.from === "focused-verify")!;
    expect(evaluateImplementStageTransition({
      ...focused,
      to: "modify",
      signal: "failed",
      verification_decision: "failed"
    })).toEqual({ allowed: true, violations: [] });

    expect(evaluateImplementStageTransition({
      ...fixture.receipt.transitions[0]!,
      to: "focused-verify"
    })).toMatchObject({ allowed: false });
    expect(evaluateImplementStageTransition({
      ...focused,
      signal: "blocked"
    })).toMatchObject({ allowed: false });
    expect(evaluateImplementStageTransition({
      ...fixture.receipt.transitions.at(-1)!,
      verification_decision: "overridden"
    })).toMatchObject({
      allowed: false,
      violations: expect.arrayContaining(["final report requires the Provider's verification commands to have passed"])
    });
  });

  for (const fixture of implementFixtures()) {
    test(`validates the canonical ${fixture.name} receipt, Evidence, and Handoff`, () => {
      expect(validateImplementWorkflowRun(fixture.receipt, fixture)).toEqual({ errors: [], ok: true });
      expect(fixture.receipt.verification.focused_evidence_ids).not.toEqual(
        fixture.receipt.verification.regression_evidence_ids
      );
      expect(fixture.handoff.delivery.mode).toBe(fixture.name);
    });
  }

  test("rejects failed regression, reused Evidence, and external writes before Handoff", () => {
    const fixture = structuredClone(implementFixtures()[0]!);
    const regressionID = fixture.receipt.verification.regression_evidence_ids[0]!;
    const regression = fixture.evidence.find((item) => item.id === regressionID)!;
    regression.status = "failed";
    regression.decisive_output.facts.outcome = "exit_nonzero";
    expect(validateImplementWorkflowRun(fixture.receipt, fixture)).toMatchObject({
      errors: expect.arrayContaining(["regression verification policy did not pass: failed"]),
      ok: false
    });

    const reused = structuredClone(implementFixtures()[0]!);
    const focusedID = reused.receipt.verification.focused_evidence_ids[0]!;
    reused.receipt.verification.regression_evidence_ids = [focusedID];
    reused.receipt.stages.find((stage) => stage.id === "regression")!.evidence_ids = [focusedID];
    expect(validateImplementWorkflowRun(reused.receipt, reused)).toMatchObject({
      errors: expect.arrayContaining([
        `focused and regression verification must use distinct Evidence: ${focusedID}`
      ]),
      ok: false
    });

    const external = structuredClone(implementFixtures()[0]!);
    external.receipt.mutation_audit[0]!.classification = "external_write";
    expect(validateImplementWorkflowRun(external.receipt, external)).toMatchObject({
      errors: expect.arrayContaining([
        "Implement local Handoff forbids external_write operation workspace.modify"
      ]),
      ok: false
    });
  });

  test("locks authority, migration, rollback, and final deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "workflow:implement@1",
      "Issue-backed Work",
      "P04 Evidence",
      "P05 Handoff",
      "双写：0",
      "双读：0",
      "回滚",
      "最终删除门禁",
      "local_changes",
      "branch_commit"
    ]) expect(adr).toContain(phrase);
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

function implementFixtures(): ImplementFixture[] {
  const parsed = JSON.parse(readFileSync(
    resolve(FIXTURES, "implement-run-fixtures-v1.json"),
    "utf8"
  )) as { fixtures: ImplementFixture[]; schema_version: string };
  if (parsed.schema_version !== "xw.implement-workflow-fixtures.v1") {
    throw new Error("unsupported Implement fixture version");
  }
  return parsed.fixtures;
}
