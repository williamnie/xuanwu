import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvidenceRecord, RunID, WorkID } from "../domain/evidence/contracts.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import {
  createLocalBranchCommitHandoffService,
  resolveLocalGitHandoffProjectPolicy,
  type LocalGitHandoffAuditEvent
} from "../domain/handoff/localBranchCommit.ts";
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
const tempDirs: string[] = [];

type ImplementFixture = ImplementWorkflowValidationContext & {
  evidence: EvidenceRecord[];
  handoff: HandoffRecord;
  name: "local_changes" | "branch_commit";
  receipt: ImplementWorkflowRun;
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

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

  test("runs a temporary-project branch commit E2E without touching unrelated worktree state", async () => {
    const fixture = structuredClone(implementFixtures().find((item) => item.name === "branch_commit")!);
    const repository = initRepository();
    writeFileSync(join(repository, "feature.ts"), "export const answer = 42;\n");
    writeFileSync(join(repository, "unrelated.txt"), "keep this dirty\n");
    const statusBefore = gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const events: LocalGitHandoffAuditEvent[] = [];
    const service = createLocalBranchCommitHandoffService({
      audit_sink: { record: (event) => { events.push(event); } },
      now: () => "2026-07-17T03:04:30.000Z",
      project_policy_reader: {
        read: () => resolveLocalGitHandoffProjectPolicy({
          allowed_actions_json: '["handoff.commit"]',
          allowed_base_branches: ["main"],
          branch_prefix: "xw/",
          branch_reuse: "same_baseline",
          commit_identity: { name: "Xuanwu Runner", email: "xuanwu@example.test" },
          commit_subject_prefixes: ["feat(workflow):"],
          max_commit_subject_length: 120,
          policy_ref: "project-policy:fixture:handoff-local-git@1",
          project_id: fixture.receipt.project_id
        })
      }
    });
    const gitEvidence = fixture.evidence.find((item) => item.kind === "git")!;
    const linkedEvidence = fixture.evidence.filter((item) => item.kind !== "git");
    const runID = fixture.receipt.run_id as RunID;
    const workID = fixture.receipt.work_id as WorkID;
    const result = await service.execute({
      audit: {
        actor: { id: "runner:issue-688", kind: "runner" },
        correlation_id: "issue-688-implement-e2e",
        intent_event_id: "issue_events:688:commit:handoff:intent",
        outcome_event_id: "issue_events:688:commit:handoff:outcome",
        rollback_event_id: "issue_events:688:commit:handoff:rollback"
      },
      commit_message: "feat(workflow): implement fixture change",
      git_evidence: {
        evidence_id: gitEvidence.id,
        producer: { id: "runner:issue-688", kind: "runner" },
        run_id: runID
      },
      linked_evidence: linkedEvidence.map((item) => ({
        id: item.id,
        status: item.status,
        work_id: item.work_id
      })),
      project_id: fixture.receipt.project_id,
      repository_path: repository,
      repository_ref: "git-repository:implement-e2e",
      run_ids: [runID],
      runs: fixture.runs,
      selected_paths: ["feature.ts"],
      work_id: workID,
      work_title: "Implement fixture branch commit"
    });

    fixture.receipt.handoff.id = result.handoff.id;
    const evidence = [...linkedEvidence, result.git_evidence];
    expect(validateImplementWorkflowRun(fixture.receipt, {
      evidence,
      handoff: result.handoff,
      runs: fixture.runs
    })).toEqual({ errors: [], ok: true });
    expect(result.diff_summary.changed_files).toEqual(["feature.ts"]);
    expect(git(repository, "branch", "--show-current")).toBe("main");
    expect(gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
      .toEqual(statusBefore);
    expect(git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_revision))
      .toBe("feature.ts");
    expect(events.map((event) => event.event_type)).toEqual([
      "handoff.local_git.intent.v1",
      "handoff.local_git.outcome.v1"
    ]);
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

function initRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "xw-implement-workflow-e2e-"));
  tempDirs.push(path);
  git(path, "init", "--initial-branch=main");
  writeFileSync(join(path, "feature.ts"), "export const answer = 0;\n");
  writeFileSync(join(path, "unrelated.txt"), "base unrelated\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial fixture");
  return path;
}

function git(repository: string, ...args: string[]): string {
  return gitBytes(repository, ...args).toString("utf8").trim();
}

function gitBytes(repository: string, ...args: string[]): Buffer {
  const result = Bun.spawnSync([
    "git",
    "-c", "user.name=Implement Fixture",
    "-c", "user.email=implement-fixture@example.test",
    "-C", repository,
    ...args
  ], {
    env: {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH ?? ""
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return Buffer.from(result.stdout);
}
