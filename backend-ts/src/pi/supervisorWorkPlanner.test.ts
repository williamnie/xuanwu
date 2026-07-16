import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../db/database.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import type { WorkflowManifest } from "../workflows/manifest.ts";
import { createWorkflowRegistry } from "../workflows/registry.ts";
import type { SupervisorContextResolution } from "./supervisorContextResolver.ts";
import { routeSupervisorIntent } from "./supervisorIntentRouter.ts";
import {
  SUPERVISOR_PLAN_MAX_DEPTH,
  SUPERVISOR_PLAN_MAX_WORK_ITEMS,
  evaluateSupervisorPlanApproval,
  planSupervisorWork,
  recordSupervisorWorkPlanAudit,
  validateSupervisorWorkPlan,
  type SupervisorPlanWorkflowPurpose,
  type SupervisorWorkPlan
} from "./supervisorWorkPlanner.ts";

const FIXTURES = resolve(
  import.meta.dir,
  "../../../docs/fixtures/supervisor-planner/supervisor-planner-v1.json"
);
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0052-supervisor-work-planner.md");
const tempRoots: string[] = [];

type PlannerFixture = {
  approval_required: boolean;
  expected_mode: SupervisorWorkPlan["mode"];
  expected_work_count: number;
  name: string;
  prompt: string;
};

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Supervisor Work Planner", () => {
  for (const fixture of plannerFixtures()) {
    test(`plans canonical ${fixture.name} fixture`, () => {
      const plan = fixturePlan(fixture.prompt);

      expect(validateSupervisorWorkPlan(plan)).toEqual([]);
      expect(plan).toMatchObject({
        approval_policy: { required: fixture.approval_required },
        materialization: {
          authority: "issues-via-work-adapter",
          relation_write: "plan_only-before-G4",
          state_writes: "not_executed"
        },
        mode: fixture.expected_mode,
        schema_version: "xw.supervisor-work-plan.v1",
        status: "ready"
      });
      expect(plan.works).toHaveLength(fixture.expected_work_count);
      expect(plan.works.every((work) => work.acceptance.criteria.length >= 2)).toBe(true);

      if (fixture.name === "simple") {
        expect(plan.works[0]).toMatchObject({
          depth: 0,
          status: "triage",
          type: "engineering_task",
          workflow_ref: "workflow:fixture-implement@1"
        });
        expect(plan.dependencies).toEqual([]);
      }
      if (fixture.name === "multi-step") {
        expect(plan.works[0]).toMatchObject({ depth: 0, type: "objective" });
        expect(plan.works.slice(1).every((work) => work.parent_work_id === plan.works[0].id)).toBe(true);
        expect(plan.dependencies).toEqual([
          { work_id: plan.works[2].id, depends_on_work_id: plan.works[1].id },
          { work_id: plan.works[3].id, depends_on_work_id: plan.works[2].id }
        ]);
        expect(plan.approval_policy.required_before).toContain("plan_materialization");
      }
      if (fixture.name === "read-only") {
        expect(plan.materialization.mode).toBe("none");
        expect(plan.workflow_selections).toContainEqual(expect.objectContaining({
          manifest_ref: "workflow:fixture-investigate@1",
          purpose: "investigate",
          status: "selected"
        }));
      }
      if (fixture.name === "release") {
        expect(plan.workflow_selections.map((selection) => selection.purpose)).toEqual([
          "implement", "release"
        ]);
        expect(plan.works.at(-1)).toMatchObject({ workflow_ref: "workflow:fixture-release@1" });
        expect(plan.works.at(-1)?.acceptance.criteria.map((criterion) => criterion.id)).toContain("release-audit");
        expect(plan.approval_policy).toMatchObject({
          decision: "ask_user",
          scope: "external_write"
        });
      }
    });
  }

  test("collapses oversized goals once and never decomposes beyond the fixed depth", () => {
    const prompt = [
      "实现大型改造：",
      ...Array.from({ length: 12 }, (_, index) => `${index + 1}. 完成步骤 ${index + 1}`)
    ].join("\n");
    const plan = fixturePlan(prompt);

    expect(plan.bounds).toMatchObject({
      actual_depth: SUPERVISOR_PLAN_MAX_DEPTH,
      max_depth: SUPERVISOR_PLAN_MAX_DEPTH,
      max_work_items: SUPERVISOR_PLAN_MAX_WORK_ITEMS,
      original_step_count: 12,
      planned_step_count: 7,
      truncated: true
    });
    expect(plan.works).toHaveLength(SUPERVISOR_PLAN_MAX_WORK_ITEMS);
    expect(Math.max(...plan.works.map((work) => work.depth))).toBe(SUPERVISOR_PLAN_MAX_DEPTH);
    expect(plan.works.at(-1)?.goal).toContain("其余 6 个有序步骤");
    expect(validateSupervisorWorkPlan(plan)).toEqual([]);
  });

  test("rejects dependency and hierarchy cycles before any Work mutation", () => {
    const plan = fixturePlan("先实现 API，然后接入页面，最后补测试");
    const children = plan.works.slice(1);
    const dependencyCycle = structuredClone(plan);
    dependencyCycle.dependencies = [
      { work_id: children[0].id, depends_on_work_id: children[1].id },
      { work_id: children[1].id, depends_on_work_id: children[0].id }
    ];
    const hierarchyCycle = structuredClone(plan);
    hierarchyCycle.works[0].parent_work_id = hierarchyCycle.works[1].id;
    hierarchyCycle.works[0].depth = 1;

    expect(validateSupervisorWorkPlan(dependencyCycle)).toContain("dependency cycle detected");
    expect(validateSupervisorWorkPlan(hierarchyCycle)).toContain("parent/child cycle detected");
  });

  test("requires audited user approval without granting tool or mutation authority", () => {
    const plan = fixturePlan("先修复构建脚本，然后发布当前版本");

    expect(evaluateSupervisorPlanApproval(plan)).toMatchObject({
      decision: "ask",
      planner_precondition_satisfied: false,
      tool_permission_granted: false
    });
    expect(evaluateSupervisorPlanApproval(plan, approval(plan, "supervisor"))).toMatchObject({
      decision: "deny",
      planner_precondition_satisfied: false,
      reasons: ["approval must come from an identified user"],
      tool_permission_granted: false
    });
    expect(evaluateSupervisorPlanApproval(plan, approval(plan, "user"))).toMatchObject({
      decision: "allow",
      planner_precondition_satisfied: true,
      tool_permission_granted: false
    });
  });

  test("fails closed when an exact Workflow revision is not registered", () => {
    const route = routeSupervisorIntent({ prompt: "实现登录修复", source: "runner_chat" });
    const plan = planSupervisorWork({
      context: resolvedContext(route.input_audit.input_digest),
      goal: "实现登录修复",
      intent_route: route,
      source: "runner_chat",
      workflow_refs: { implement: "workflow:missing@1" },
      workflow_registry: workflowRegistry()
    });

    expect(plan).toMatchObject({
      approval_policy: { decision: "blocked", materialization_permitted: false },
      status: "blocked",
      works: []
    });
    expect(plan.reason).toContain("Workflow Registry rejected workflow:missing@1");
    expect(validateSupervisorWorkPlan(plan)).toEqual([]);
  });

  test("persists the complete bounded plan as an append-only planner audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-supervisor-plan-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const plan = fixturePlan("实现登录页错误提示并补 focused test");
      recordSupervisorWorkPlanAudit(db, {
        conversationID: "conv-plan",
        turnID: "turn-plan"
      }, plan);

      const events = listPiActionEvents(db, {
        conversationId: "conv-plan",
        eventType: "supervisor_work_planned"
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action_id: "work-plan:turn-plan",
        actor: "supervisor_work_planner",
        decision: "ready",
        project_id: "demo"
      });
      expect(JSON.parse(events[0].payload_json)).toEqual(plan);
    } finally {
      db.close();
    }
  });

  test("locks authority, compatibility, rollback and deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "xw.supervisor-work-plan.v1",
      "最大层级 | 1",
      "issues-via-work-adapter",
      "双写：0",
      "双读：0",
      "回滚",
      "最终删除门禁",
      "tool_permission_granted"
    ]) expect(adr).toContain(phrase);
  });
});

function fixturePlan(prompt: string): SupervisorWorkPlan {
  const route = routeSupervisorIntent({ prompt, source: "runner_chat" });
  return planSupervisorWork({
    context: resolvedContext(route.input_audit.input_digest),
    goal: prompt,
    intent_route: route,
    source: "runner_chat",
    workflow_refs: {
      implement: "workflow:fixture-implement@1",
      investigate: "workflow:fixture-investigate@1",
      release: "workflow:fixture-release@1"
    },
    workflow_registry: workflowRegistry()
  });
}

function resolvedContext(inputDigest: string): SupervisorContextResolution {
  return {
    candidates: [{
      project_id: "demo",
      score: 100,
      sources: [{ kind: "explicit_project", ref: "projects:demo", score: 100 }],
      work_ids: []
    }],
    clarification: { reason: "one project target is proven", required: false },
    input_audit: { char_count: 1, input_digest: inputDigest },
    provenance: {
      context_inheritance_allowed: true,
      conversation_id: "conv-plan",
      resolver: "deterministic_supervisor_context",
      source: "runner_chat"
    },
    reason: "explicit project target",
    schema_version: "xw.supervisor-context-resolution.v1",
    status: "resolved",
    target: { issue_ids: [], project_id: "demo", work_ids: [] }
  };
}

function workflowRegistry() {
  const purposes: SupervisorPlanWorkflowPurpose[] = ["investigate", "implement", "release"];
  return createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: [],
    manifests: purposes.map((purpose) => ({
      manifest: workflowManifest(purpose),
      source_path: `fixture:${purpose}`
    })),
    skills: [],
    tools: [],
    verification_policies: purposes.map(verificationPolicy)
  });
}

function workflowManifest(purpose: SupervisorPlanWorkflowPurpose): WorkflowManifest {
  const release = purpose === "release";
  return {
    schema_version: "xuanwu.workflow-manifest.v1",
    id: `workflow:fixture-${purpose}`,
    revision: 1,
    name: `Fixture ${purpose}`,
    description: `Provider-neutral ${purpose} planner fixture.`,
    stages: [{
      id: purpose,
      name: `Execute ${purpose}`,
      agent: { role: purpose === "investigate" ? "reporter" : "executor", required_skill_ids: [] },
      permissions: {
        max_tool_permission: release ? "dangerous" : purpose === "investigate" ? "read" : "write",
        allowed_tools: [],
        allowed_actions: []
      },
      verification_policy_ref: `verification-policy:fixture-${purpose}@1`,
      retry: { max_attempts: 1, backoff_seconds: [] },
      approval: release
        ? { mode: "before_external_write", policy_ref: "approval-policy:release@1" }
        : { mode: "none" },
      handoff: {
        mode: release ? "release" : "local_changes",
        required: true,
        project_override_modes: [release ? "release" : "local_changes"]
      }
    }]
  };
}

function verificationPolicy(purpose: SupervisorPlanWorkflowPurpose): WorkflowVerificationPolicy {
  return {
    schema_version: 1,
    id: `verification-policy:fixture-${purpose}`,
    revision: 1,
    name: `Fixture ${purpose} policy`,
    kind_rules: [],
    required_groups: [{
      id: "focused",
      operator: "all",
      requirements: [{
        id: "focused-evidence",
        evidence_kinds: [purpose === "release" ? "git" : "test"],
        scope: "work",
        fact_assertions: [],
        artifact_policy: "ignore"
      }]
    }],
    optional_requirements: [],
    risk_overrides: []
  };
}

function approval(
  plan: SupervisorWorkPlan,
  kind: "user" | "supervisor"
) {
  return {
    actor: { id: `${kind}-1`, kind },
    audit_event_ref: `pi_action_events:approval:${plan.plan_id}`,
    decision: "approve" as const,
    occurred_at: "2026-07-17T10:00:00.000Z",
    plan_id: plan.plan_id
  };
}

function plannerFixtures(): PlannerFixture[] {
  const parsed = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
    fixtures: PlannerFixture[];
    schema_version: string;
  };
  if (parsed.schema_version !== "xw.supervisor-planner-fixtures.v1") {
    throw new Error("unsupported Supervisor planner fixture version");
  }
  return parsed.fixtures;
}
