import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceRecord, RunID, WorkID } from "../domain/evidence/contracts.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import { listBrowserAssistantTools } from "../pi/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/httpToolProvider.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  MIGRATE_VERIFICATION_POLICY,
  MIGRATE_WORKFLOW_MANIFEST,
  MIGRATE_WORKFLOW_REF,
  RELEASE_VERIFICATION_POLICY,
  RELEASE_WORKFLOW_MANIFEST,
  RELEASE_WORKFLOW_REF,
  RESEARCH_VERIFICATION_POLICY,
  RESEARCH_WORKFLOW_MANIFEST,
  RESEARCH_WORKFLOW_REF,
  completeReleaseWorkflow,
  longRunningWorkflowRegistryContributions,
  validateMigrateWorkflowExecution,
  validateResearchWorkflowReport,
  type MigrateWorkflowExecution,
  type ResearchWorkflowReport,
  type WorkflowRuntimeContext
} from "./releaseResearchMigrate.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0057-release-research-migrate-workflows.md");
const NOW = "2026-07-17T03:30:00.000Z";
const OBSERVED_AT = "2026-07-17T03:00:00.000Z";
const WORK_ID = "xw:work:issues:690" as WorkID;
const RUN_ID = "xw:run:issue_runs:690" as RunID;
const SOURCE_DIGEST = "a".repeat(64);
const TARGET_DIGEST = "b".repeat(64);

describe("Release, Research, and Migrate Workflows", () => {
  test("registers the three exact canonical manifests and their Evidence policies", () => {
    const fixtures = [
      ["release-workflow-v1.json", RELEASE_WORKFLOW_MANIFEST],
      ["research-workflow-v1.json", RESEARCH_WORKFLOW_MANIFEST],
      ["migrate-workflow-v1.json", MIGRATE_WORKFLOW_MANIFEST]
    ] as const;
    for (const [name, manifest] of fixtures) {
      expect(JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"))).toEqual(manifest);
      expect(validateWorkflowManifest(manifest)).toEqual({ issues: [], ok: true });
    }

    const contributions = longRunningWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: ["release.execute", "migration.apply", "work.update"],
      manifests: contributions.manifests,
      skills: [],
      tools: [
        ...listBuiltinAssistantTools(),
        ...listHttpAssistantTools(),
        ...listBrowserAssistantTools()
      ],
      verification_policies: contributions.verification_policies
    });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.items.map((item) => item.ref)).toEqual([
      MIGRATE_WORKFLOW_REF,
      RELEASE_WORKFLOW_REF,
      RESEARCH_WORKFLOW_REF
    ]);
    for (const ref of [RELEASE_WORKFLOW_REF, RESEARCH_WORKFLOW_REF, MIGRATE_WORKFLOW_REF]) {
      expect(registry.resolve(ref)).toMatchObject({ ok: true, resolution: { manifest_ref: ref } });
    }
    expect(RELEASE_VERIFICATION_POLICY.id).toBe("verification-policy:release-readiness");
    expect(RESEARCH_VERIFICATION_POLICY.id).toBe("verification-policy:research-source-evidence");
    expect(MIGRATE_VERIFICATION_POLICY.id).toBe("verification-policy:migrate-contracts");
  });

  test("sandbox E2E: completes an approved release with trusted Evidence and rollback", () => {
    const evidence = [
      evidenceRecord("release-build", "build", { outcome: "passed" }, RUN_ID),
      evidenceRecord("release-git", "git", { revision: "commit:release-1" }, RUN_ID)
    ];
    const handoff = releaseHandoff(evidence);

    expect(completeReleaseWorkflow({
      context: runtimeContext(evidence, handoff),
      project_id: "fixture-project",
      run_id: RUN_ID
    })).toMatchObject({
      handoff_id: handoff.id,
      release_ref: "release://fixture/v1.2.3",
      rollback: { availability: "available" },
      status: "released",
      version: "1.2.3",
      workflow_ref: RELEASE_WORKFLOW_REF
    });
  });

  test("fails closed when a destructive release lacks human approval or rollback", () => {
    const evidence = [
      evidenceRecord("release-build", "build", { outcome: "passed" }, RUN_ID),
      evidenceRecord("release-git", "git", { revision: "commit:release-1" }, RUN_ID)
    ];
    const handoff = releaseHandoff(evidence);
    handoff.delivery_actions[0]!.gate.authority = "deterministic_policy";
    handoff.rollback = { availability: "blocked", destructive: false, reason: "rollback removed", refs: [] };
    handoff.risks = [{
      id: "rollback-blocked",
      severity: "high",
      summary: "Rollback is unavailable",
      mitigation: "Do not publish",
      source_refs: ["fixture:risk"]
    }];

    expect(() => completeReleaseWorkflow({
      context: runtimeContext(evidence, handoff),
      project_id: "fixture-project",
      run_id: RUN_ID
    })).toThrow("destructive release action requires human approval");
    expect(() => completeReleaseWorkflow({
      context: runtimeContext(evidence, handoff),
      project_id: "fixture-project",
      run_id: RUN_ID
    })).toThrow("available, referenced rollback plan");
  });

  test("sandbox E2E: validates a read-only report whose every claim links to source Evidence", () => {
    const sourceURL = "https://sandbox.example/docs/contract";
    const evidence = [evidenceRecord(
      "research-http",
      "http",
      { source_locator: sourceURL },
      undefined,
      [{ kind: "url", ref: sourceURL }]
    )];
    const handoff = researchHandoff(evidence);
    const report: ResearchWorkflowReport = {
      schema_version: "xw.research-workflow-report.v1",
      workflow_ref: RESEARCH_WORKFLOW_REF,
      project_id: "fixture-project",
      work_id: WORK_ID,
      status: "completed",
      question: "What contract does the sandbox source publish?",
      report_ref: "reports/research.md",
      sources: [{
        id: "source-doc",
        kind: "url",
        locator: sourceURL,
        title: "Sandbox source contract",
        retrieved_at: OBSERVED_AT,
        evidence_id: evidence[0]!.id
      }],
      claims: [{
        id: "claim-contract",
        statement: "The source publishes contract revision 1.",
        source_ids: ["source-doc"]
      }],
      evidence_ids: [evidence[0]!.id],
      handoff_id: handoff.id,
      read_only_audit: {
        confirmation: "no_source_or_external_state_mutation",
        audit_event_refs: ["audit:research:read"],
        state_mutations: [],
        external_writes: [],
        destructive_operations: []
      }
    };

    expect(validateResearchWorkflowReport(report, runtimeContext(evidence, handoff)))
      .toEqual({ errors: [], ok: true });

    const uncited = structuredClone(report);
    uncited.claims[0]!.source_ids = ["missing-source"];
    expect(validateResearchWorkflowReport(uncited, runtimeContext(evidence, handoff))).toMatchObject({
      errors: expect.arrayContaining([
        "research claim claim-contract references unknown source missing-source",
        "research source source-doc is not cited by any claim"
      ]),
      ok: false
    });
  });

  test("sandbox E2E: validates approved cross-repository migration contracts and target Handoff", () => {
    const evidence = [
      evidenceRecord("migrate-source", "git", {
        contract_digest: SOURCE_DIGEST,
        repository_role: "source"
      }, RUN_ID),
      evidenceRecord("migrate-target", "test", {
        contract_digest: TARGET_DIGEST,
        outcome: "passed",
        repository_role: "target"
      }, RUN_ID)
    ];
    const handoff = migrateHandoff(evidence);
    const execution = migrateExecution(evidence, handoff);

    expect(validateMigrateWorkflowExecution(execution, runtimeContext(evidence, handoff)))
      .toEqual({ errors: [], ok: true });

    const unapproved = structuredClone(execution) as MigrateWorkflowExecution;
    (unapproved.mutation.authorization as { authority: string }).authority = "deterministic_policy";
    expect(validateMigrateWorkflowExecution(unapproved, runtimeContext(evidence, handoff))).toMatchObject({
      errors: [expect.stringContaining("schema /mutation/authorization/authority")],
      ok: false
    });
  });

  test("locks source of truth, compatibility, rollback, and final deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "workflow:release@1",
      "workflow:research@1",
      "workflow:migrate@1",
      "P04 Evidence",
      "P05 Handoff",
      "source repository 是唯一 source of truth",
      "双写：0",
      "双读：仅 bounded validation window",
      "release rollback",
      "最终删除门禁"
    ]) expect(adr).toContain(phrase);
  });
});

function runtimeContext(evidence: EvidenceRecord[], handoff: HandoffRecord): WorkflowRuntimeContext {
  return {
    evidence,
    handoff,
    now: NOW,
    runs: handoff.run_ids.map((id) => ({ id, work_id: handoff.work_id }))
  };
}

function evidenceRecord(
  suffix: string,
  kind: "build" | "git" | "http" | "test",
  facts: Record<string, string>,
  runIDValue?: RunID,
  artifactRefs: EvidenceRecord["artifact_refs"] = []
): EvidenceRecord {
  const sourceKind = kind === "git" ? "git_repository"
    : kind === "http" ? "http_exchange"
    : kind === "build" ? "build_system"
    : "test_runner";
  const authority = kind === "git" ? "git" : "issue_events";
  return {
    schema_version: 1,
    id: `xw:evidence:${authority}:${suffix}` as EvidenceRecord["id"],
    work_id: WORK_ID,
    ...(runIDValue ? { run_id: runIDValue } : {}),
    revision: 0,
    kind,
    status: "passed",
    created_at: OBSERVED_AT,
    observed_at: OBSERVED_AT,
    updated_at: OBSERVED_AT,
    completed_at: OBSERVED_AT,
    decisive_output: {
      summary: `${kind} fixture passed`,
      facts
    },
    artifact_refs: artifactRefs,
    provenance: {
      assertion_origin: "tool_result",
      source_kind: sourceKind,
      source_ref: `sandbox:${suffix}`,
      audit_event_ref: `audit:${suffix}`,
      producer: { id: "sandbox-runner", kind: "runner" }
    },
    redaction: { status: "not_required", policy_ref: "redaction:fixture", redacted_paths: [] }
  };
}

function baseHandoff(
  evidence: EvidenceRecord[],
  input: Pick<HandoffRecord, "delivery" | "delivery_actions" | "rollback"> & {
    changed_files: string[];
    final_revision: string;
    status: "ready" | "delivered";
    suffix: string;
  }
): HandoffRecord {
  return {
    schema_version: 1,
    id: `xw:handoff:derived:${input.suffix}` as HandoffRecord["id"],
    work_id: WORK_ID,
    run_ids: [RUN_ID],
    evidence_ids: evidence.map((item) => item.id),
    revision: 0,
    status: input.status,
    summary: `${input.suffix} sandbox Handoff`,
    created_at: OBSERVED_AT,
    updated_at: OBSERVED_AT,
    baseline_revision: "commit:baseline",
    final_revision: input.final_revision,
    review_ref: `review:${input.suffix}`,
    changed_files: input.changed_files,
    delivery: input.delivery,
    delivery_actions: input.delivery_actions,
    risks: [],
    rollback: input.rollback,
    review: {
      required: false,
      state: "not_applicable",
      reviewer_refs: []
    }
  };
}

function releaseHandoff(evidence: EvidenceRecord[]): HandoffRecord {
  return baseHandoff(evidence, {
    suffix: "release-690",
    status: "delivered",
    changed_files: [],
    final_revision: "commit:release-1",
    delivery: {
      mode: "release",
      release_ref: "release://fixture/v1.2.3",
      revision_ref: "commit:release-1",
      version: "1.2.3"
    },
    delivery_actions: [{
      action: "release",
      required: true,
      classification: "destructive",
      target: "release://fixture/production",
      gate: { authority: "human_approval", policy_ref: "approval-policy:release-external-write@1" },
      gate_decision: "allow",
      outcome: "succeeded",
      audit_event_ref: "audit:release:outcome",
      before_ref: "release://fixture/v1.2.2",
      after_ref: "release://fixture/v1.2.3",
      rollback_ref: "runbook:release-rollback"
    }],
    rollback: {
      availability: "available",
      destructive: false,
      plan: "Redeploy release v1.2.2 and verify the production health check.",
      refs: ["runbook:release-rollback"]
    }
  });
}

function researchHandoff(evidence: EvidenceRecord[]): HandoffRecord {
  return baseHandoff(evidence, {
    suffix: "research-690",
    status: "ready",
    changed_files: ["reports/research.md"],
    final_revision: "working-tree:research-report",
    delivery: { mode: "local_changes", working_tree_ref: "working-tree:research-report" },
    delivery_actions: [],
    rollback: { availability: "not_required", destructive: false, refs: [] }
  });
}

function migrateHandoff(evidence: EvidenceRecord[]): HandoffRecord {
  return baseHandoff(evidence, {
    suffix: "migrate-690",
    status: "ready",
    changed_files: ["lib/target_contract.ts"],
    final_revision: "commit:target-2",
    delivery: {
      mode: "branch_commit",
      branch_ref: "refs/heads/xw-migrate",
      commit_ref: "commit:target-2"
    },
    delivery_actions: [{
      action: "commit",
      required: true,
      classification: "state_change",
      target: "repo://target",
      gate: { authority: "deterministic_policy", policy_ref: "policy:scoped-target-commit" },
      gate_decision: "allow",
      outcome: "succeeded",
      audit_event_ref: "audit:migrate:commit",
      before_ref: "commit:target-1",
      after_ref: "commit:target-2",
      rollback_ref: "checkpoint:migrate-target-1"
    }],
    rollback: {
      availability: "available",
      destructive: false,
      plan: "Reset only the scoped target paths to commit:target-1.",
      refs: ["checkpoint:migrate-target-1"]
    }
  });
}

function migrateExecution(evidence: EvidenceRecord[], handoff: HandoffRecord): MigrateWorkflowExecution {
  return {
    schema_version: "xw.migrate-workflow-execution.v1",
    workflow_ref: MIGRATE_WORKFLOW_REF,
    project_id: "fixture-project",
    work_id: WORK_ID,
    run_id: RUN_ID,
    status: "completed",
    source: {
      repository_ref: "repo://source",
      revision: "commit:source-1",
      contract_ref: "contracts/source.json",
      contract_digest: SOURCE_DIGEST
    },
    target: {
      repository_ref: "repo://target",
      baseline_revision: "commit:target-1",
      revision: "commit:target-2",
      contract_ref: "lib/target_contract.ts",
      contract_digest: TARGET_DIGEST
    },
    mappings: [{
      source_path: "contracts/source.json",
      target_path: "lib/target_contract.ts",
      adapter_ref: "adapter:source-to-target@1"
    }],
    authority: {
      source_of_truth: "source_repository",
      target_role: "derived_until_cutover",
      dual_write: "disabled",
      dual_read: "bounded_validation_only",
      deletion_gate_ref: "gate:migrate-final-delete"
    },
    evidence_ids: evidence.map((item) => item.id),
    source_evidence_ids: [evidence[0]!.id],
    target_evidence_ids: [evidence[1]!.id],
    mutation: {
      action: "migration.apply",
      classification: "external_write",
      target: "repo://target",
      outcome: "succeeded",
      authorization: {
        authority: "human_approval",
        decision: "allow",
        policy_ref: "approval-policy:migrate-target-write@1",
        audit_event_ref: "audit:migrate:approval"
      },
      audit_event_ref: "audit:migrate:outcome",
      before_ref: "commit:target-1",
      after_ref: "commit:target-2",
      rollback_ref: "checkpoint:migrate-target-1"
    },
    rollback: {
      plan: "Restore mapped target paths from commit:target-1.",
      checkpoint_ref: "checkpoint:migrate-target-1",
      destructive: false
    },
    handoff_id: handoff.id
  };
}
