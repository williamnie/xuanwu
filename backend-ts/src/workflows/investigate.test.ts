import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listBrowserAssistantTools } from "../pi/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/httpToolProvider.ts";
import {
  evaluateWorkflowVerificationPolicy,
  validateWorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  INVESTIGATE_STAGE_IDS,
  INVESTIGATE_VERIFICATION_POLICY,
  INVESTIGATE_WORKFLOW_MANIFEST,
  INVESTIGATE_WORKFLOW_REF,
  investigateWorkflowRegistryContributions,
  validateInvestigateHandoffReport,
  type InvestigateHandoffReport
} from "./investigate.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0054-investigate-workflow.md");

type InvestigateFixture = {
  evidence: EvidenceRecord[];
  name: "confirmed" | "not_reproduced" | "insufficient_information";
  report: InvestigateHandoffReport;
};

describe("Investigate Workflow", () => {
  test("registers and resolves the exact canonical read-only revision", () => {
    const fixtureManifest = JSON.parse(readFileSync(resolve(FIXTURES, "investigate-workflow-v1.json"), "utf8"));
    expect(fixtureManifest).toEqual(INVESTIGATE_WORKFLOW_MANIFEST);
    expect(validateWorkflowManifest(INVESTIGATE_WORKFLOW_MANIFEST)).toEqual({ issues: [], ok: true });
    expect(validateWorkflowVerificationPolicy(INVESTIGATE_VERIFICATION_POLICY)).toEqual({ errors: [], ok: true });

    const registry = investigateRegistry();

    expect(registry.diagnostics).toEqual([]);
    expect(registry.resolve(INVESTIGATE_WORKFLOW_REF)).toMatchObject({
      ok: true,
      resolution: { manifest: { id: "workflow:investigate", revision: 1 } }
    });
  });

  test("fails closed when a catalog widens any allowed tool beyond read permission", () => {
    expect(INVESTIGATE_WORKFLOW_MANIFEST.stages.map((stage) => stage.id)).toEqual([...INVESTIGATE_STAGE_IDS]);
    for (const stage of INVESTIGATE_WORKFLOW_MANIFEST.stages) {
      expect(stage.permissions.max_tool_permission).toBe("read");
      expect(stage.permissions.allowed_actions).toEqual([]);
      expect(stage.approval).toEqual({ mode: "none" });
    }

    const tools = investigateTools().map((tool) =>
      tool.name === "repo_search" ? { ...tool, permission: "write" as const } : tool
    );
    const contributions = investigateWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: [],
      manifests: contributions.manifests,
      skills: [],
      tools,
      verification_policies: contributions.verification_policies
    });

    expect(registry.diagnostics).toContainEqual(expect.objectContaining({
      code: "permission_conflict",
      message: "tool runner-builtin:repo_search requires write"
    }));
    expect(registry.resolve(INVESTIGATE_WORKFLOW_REF)).toMatchObject({ ok: false });
  });

  for (const fixture of investigateFixtures()) {
    test(`validates ${fixture.name} report, linked Evidence, and no-write audit`, () => {
      const validation = validateInvestigateHandoffReport(fixture.report, fixture.evidence);
      expect(validation).toEqual({ errors: [], ok: true });
      expect(fixture.report.read_only_audit).toMatchObject({
        allowed_actions: [],
        changed_files: [],
        confirmation: "no_write_operations_observed",
        destructive_operations: [],
        external_writes: [],
        state_mutations: []
      });

      const evaluation = evaluateWorkflowVerificationPolicy({
        context: {
          now: "2026-07-17T01:00:00.000Z",
          project_id: "fixture-project",
          risk: "safe",
          work_id: fixture.report.work_id as EvidenceRecord["work_id"]
        },
        evidence: fixture.evidence,
        policy: INVESTIGATE_VERIFICATION_POLICY
      });
      expect(evaluation).toMatchObject({ decision: "passed", satisfied: true });
    });
  }

  test("rejects report mutations and missing Evidence instead of trusting model narrative", () => {
    const fixture = investigateFixtures()[0]!;
    const mutated = structuredClone(fixture.report) as InvestigateHandoffReport;
    mutated.read_only_audit.changed_files.push("src/unauthorized.ts");

    expect(validateInvestigateHandoffReport(mutated, fixture.evidence)).toMatchObject({ ok: false });
    expect(validateInvestigateHandoffReport(fixture.report, [])).toMatchObject({
      errors: expect.arrayContaining([
        "linked Evidence is missing: xw:evidence:issue_events:investigate-confirmed",
        "report requires at least one passed trusted Evidence observation"
      ]),
      ok: false
    });
  });

  test("locks authority, compatibility, rollback, and deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "workflow:investigate@1",
      "P04 Evidence",
      "P05 Handoff",
      "双写：0",
      "双读：0",
      "回滚",
      "最终删除门禁",
      "changed_files=[]"
    ]) expect(adr).toContain(phrase);
  });
});

function investigateRegistry() {
  const contributions = investigateWorkflowRegistryContributions();
  return createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: [],
    manifests: contributions.manifests,
    skills: [],
    tools: investigateTools(),
    verification_policies: contributions.verification_policies
  });
}

function investigateTools() {
  return [
    ...listBuiltinAssistantTools(),
    ...listHttpAssistantTools(),
    ...listBrowserAssistantTools()
  ];
}

function investigateFixtures(): InvestigateFixture[] {
  const parsed = JSON.parse(readFileSync(
    resolve(FIXTURES, "investigate-handoff-fixtures-v1.json"),
    "utf8"
  )) as { fixtures: InvestigateFixture[]; schema_version: string };
  if (parsed.schema_version !== "xw.investigate-handoff-fixtures.v1") {
    throw new Error("unsupported Investigate fixture version");
  }
  return parsed.fixtures;
}
