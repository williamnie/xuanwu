import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  DELIVERY_MODES,
  HANDOFF_SCHEMA,
  HANDOFF_STATE_TRANSITIONS,
  REVIEW_STATES,
  evaluateHandoffTransition,
  validateHandoff,
  type DeliveryMode,
  type HandoffDelivery,
  type HandoffDeliveryAction,
  type HandoffLinkContext,
  type HandoffRecord,
  type HandoffTransitionCommand
} from "./contracts.ts";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T12:01:00.000Z";
const WORK_ID = makeDomainID("work", "issues", 672);
const RUN_ID = makeDomainID("run", "issue_runs", "672:1");
const EVIDENCE_ID = makeDomainID("evidence", "issue_events", "672:test");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ADR_PATH = "docs/architecture/xuanwu/0036-handoff-delivery-contract.md";

describe("Handoff / Delivery domain contract", () => {
  test("publishes every delivery mode and reuses the P00.04 status machine", () => {
    expect(DELIVERY_MODES).toEqual([
      "local_changes",
      "branch_commit",
      "push",
      "draft_pr",
      "ready_pr",
      "deploy",
      "release"
    ]);
    expect(REVIEW_STATES).toEqual([
      "not_requested",
      "pending",
      "approved",
      "changes_requested",
      "not_applicable"
    ]);
    expect(HANDOFF_STATE_TRANSITIONS).toEqual({
      draft: ["ready", "superseded"],
      ready: ["delivered", "superseded"],
      delivered: ["superseded"],
      superseded: []
    });
  });

  test("accepts a runnable schema for every delivery mode", () => {
    for (const mode of DELIVERY_MODES) {
      const handoff = record(mode);
      expect(Value.Check(HANDOFF_SCHEMA, handoff), mode).toBe(true);
      expect(validateHandoff(handoff, context()), mode).toEqual({ errors: [], ok: true });
    }
  });

  test("zero-file local receipts require unchanged refs, no delivery actions and linked execution evidence", () => {
    const handoff = record("local_changes");
    handoff.changed_files = [];
    expect(validateHandoff(handoff, context()).ok).toBe(false);
    handoff.baseline_revision = handoff.final_revision;
    expect(validateHandoff(handoff, context()).ok).toBe(true);
    handoff.run_ids = [];
    expect(validateHandoff(handoff, context()).ok).toBe(false);
    const external = record("push");
    external.changed_files = [];
    expect(validateHandoff(external, context()).ok).toBe(false);
  });

  test("fails closed when a delivery mode omits its required artifact fields", () => {
    const requiredFieldByMode: Record<DeliveryMode, string> = {
      local_changes: "working_tree_ref",
      branch_commit: "commit_ref",
      push: "remote_ref",
      draft_pr: "pull_request_ref",
      ready_pr: "url",
      deploy: "deployment_ref",
      release: "version"
    };

    for (const mode of DELIVERY_MODES) {
      const handoff = record(mode) as HandoffRecord & { delivery: Record<string, unknown> };
      delete handoff.delivery[requiredFieldByMode[mode]];
      expect(Value.Check(HANDOFF_SCHEMA, handoff), mode).toBe(false);
      expect(validateHandoff(handoff, context()).ok, mode).toBe(false);
    }
  });

  test("requires same-Work links and passed Evidence before ready", () => {
    const handoff = record("local_changes");
    const wrongWork = makeDomainID("work", "issues", 999);
    const wrongContext = context();
    wrongContext.runs[0].work_id = wrongWork;
    wrongContext.evidence[0].work_id = wrongWork;
    wrongContext.evidence[0].status = "failed";

    expect(validateHandoff(handoff, wrongContext).errors).toEqual(expect.arrayContaining([
      `${RUN_ID} Run belongs to another Work`,
      `${EVIDENCE_ID} Evidence belongs to another Work`,
      "ready Handoff requires passed Evidence"
    ]));

    handoff.run_ids.push(RUN_ID);
    handoff.evidence_ids.push(EVIDENCE_ID);
    expect(validateHandoff(handoff, context()).errors).toEqual(expect.arrayContaining([
      "run_ids must be unique",
      "evidence_ids must be unique"
    ]));
  });

  test("enforces delivery actions, review, risk, and rollback semantics", () => {
    const push = record("push");
    push.delivery_actions = push.delivery_actions.filter((action) => action.action !== "push");
    expect(validateHandoff(push, context()).errors).toContain("push requires a required push delivery action");

    const release = record("release");
    release.rollback = { availability: "not_required", destructive: false, refs: [] };
    expect(validateHandoff(release, context()).errors).toContain("release must define an available or blocked rollback");

    release.rollback = { availability: "blocked", destructive: false, refs: [] };
    release.risks = [];
    expect(validateHandoff(release, context()).errors).toEqual(expect.arrayContaining([
      "blocked rollback requires a reason",
      "blocked rollback requires a recorded risk"
    ]));

    const readyPR = record("ready_pr");
    readyPR.review = { required: true, reviewer_refs: [], state: "not_requested" };
    expect(validateHandoff(readyPR, context()).errors).toContain("ready_pr requires an active review state");
  });

  test("requires audited deterministic transitions and successful required actions before delivered", () => {
    const draft = record("push", "draft");
    const ready = transition(draft, "ready");
    expect(evaluateHandoffTransition(draft, context(), ready)).toEqual({ allowed: true, violations: [] });

    ready.audit.gate.decision = "ask";
    expect(evaluateHandoffTransition(draft, context(), ready).violations)
      .toContain("transition gate requires approval");
    ready.audit.gate.decision = "allow";
    ready.audit.gate.authority = "llm" as HandoffTransitionCommand["audit"]["gate"]["authority"];
    expect(evaluateHandoffTransition(draft, context(), ready).violations)
      .toContain("transition gate authority is not trusted");

    const pendingDelivery = record("push", "ready");
    pendingDelivery.delivery_actions.find((action) => action.action === "push")!.outcome = "not_executed";
    delete pendingDelivery.delivery_actions.find((action) => action.action === "push")!.after_ref;
    expect(evaluateHandoffTransition(pendingDelivery, context(), transition(pendingDelivery, "delivered")).violations)
      .toContain("delivered Handoff requires push to succeed");

    const delivered = record("push", "ready");
    delivered.review = {
      decided_at: LATER,
      required: true,
      review_ref: "review:672",
      reviewer_refs: ["user:reviewer"],
      state: "approved"
    };
    delivered.review_ref = "review:672";
    expect(evaluateHandoffTransition(delivered, context(), transition(delivered, "delivered")))
      .toEqual({ allowed: true, violations: [] });

    delivered.status = "delivered";
    expect(evaluateHandoffTransition(delivered, context(), transition(delivered, "ready")).violations)
      .toContain("illegal Handoff transition delivered -> ready");
  });

  test("requires a replacement identity when superseding an immutable Handoff version", () => {
    const ready = record("local_changes", "ready");
    const command = transition(ready, "superseded");
    expect(evaluateHandoffTransition(ready, context(), command).violations)
      .toContain("superseded transition requires superseding_handoff_id");
    command.superseding_handoff_id = makeDomainID("handoff", "derived", "672@tree-2");
    expect(evaluateHandoffTransition(ready, context(), command)).toEqual({ allowed: true, violations: [] });
  });

  test("documents authorities, compatibility window, rollback, and final deletion gate", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of [
      "Delivery mode 与必填事实",
      "Handoff schema",
      "状态与 review",
      "风险与 rollback",
      "审计与权限门禁",
      "兼容、迁移与删除门禁"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("P00.04 继续是 Handoff ID、四态词表和状态边的唯一 source of truth");
    expect(adr).toContain("本期双写窗口为 0");
    expect(adr).toContain("W1 与 W2 合计最多两个正式 release window");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("LLM 输出不能提供 allow");
  });
});

function record(mode: DeliveryMode, status: HandoffRecord["status"] = "ready"): HandoffRecord {
  const delivery = deliveryFor(mode);
  const requiredActions = actionsFor(mode);
  return {
    schema_version: 1,
    id: makeDomainID("handoff", "derived", `672@${mode}`),
    work_id: WORK_ID,
    run_ids: [RUN_ID],
    evidence_ids: [EVIDENCE_ID],
    revision: 0,
    status,
    summary: `${mode} handoff`,
    created_at: NOW,
    updated_at: LATER,
    baseline_revision: "git:base",
    final_revision: finalRevision(delivery),
    review_ref: mode === "draft_pr" || mode === "ready_pr" ? "pr:672" : finalRevision(delivery),
    changed_files: mode === "deploy" || mode === "release" ? [] : ["backend-ts/src/domain/handoff/contracts.ts"],
    delivery,
    delivery_actions: requiredActions,
    risks: [{
      id: "compatibility",
      severity: "low",
      summary: "legacy consumers do not read this contract yet",
      mitigation: "retain the legacy projection until the migration gate passes",
      source_refs: ["docs:xuanwu-migration-plan"]
    }],
    rollback: mode === "local_changes"
      ? { availability: "not_required", destructive: false, refs: [] }
      : { availability: "available", destructive: false, plan: `reverse ${mode}`, refs: [`rollback:${mode}`] },
    review: mode === "ready_pr"
      ? {
          required: true,
          state: "pending",
          review_ref: "pr:672",
          reviewer_refs: ["user:reviewer"]
        }
      : { required: false, state: "not_requested", reviewer_refs: [] }
  };
}

function deliveryFor(mode: DeliveryMode): HandoffDelivery {
  switch (mode) {
    case "local_changes": return { mode, working_tree_ref: "git:tree-672" };
    case "branch_commit": return { mode, branch_ref: "refs/heads/xw-672", commit_ref: "git:commit-672" };
    case "push": return {
      mode,
      branch_ref: "refs/heads/xw-672",
      commit_ref: "git:commit-672",
      remote_ref: "origin/xw-672"
    };
    case "draft_pr": return {
      mode,
      branch_ref: "refs/heads/xw-672",
      commit_ref: "git:commit-672",
      remote_ref: "origin/xw-672",
      pull_request_ref: "pr:672",
      url: "https://provider.invalid/pr/672"
    };
    case "ready_pr": return {
      mode,
      branch_ref: "refs/heads/xw-672",
      commit_ref: "git:commit-672",
      remote_ref: "origin/xw-672",
      pull_request_ref: "pr:672",
      url: "https://provider.invalid/pr/672"
    };
    case "deploy": return {
      mode,
      deployment_ref: "deploy:672",
      environment: "staging",
      revision_ref: "git:commit-672"
    };
    case "release": return {
      mode,
      release_ref: "release:v1.0.0",
      revision_ref: "git:commit-672",
      version: "v1.0.0"
    };
  }
}

function finalRevision(delivery: HandoffDelivery): string {
  switch (delivery.mode) {
    case "local_changes": return delivery.working_tree_ref;
    case "branch_commit":
    case "push":
    case "draft_pr":
    case "ready_pr": return delivery.commit_ref;
    case "deploy":
    case "release": return delivery.revision_ref;
  }
}

function actionsFor(mode: DeliveryMode): HandoffDeliveryAction[] {
  const kinds = mode === "local_changes" ? []
    : mode === "branch_commit" ? ["commit"] as const
    : mode === "push" ? ["commit", "push"] as const
    : mode === "draft_pr" || mode === "ready_pr" ? ["commit", "push", "pull_request"] as const
    : mode === "deploy" ? ["deploy"] as const
    : ["release"] as const;
  return kinds.map((action) => ({
    action,
    required: true,
    classification: action === "commit" ? "state_change"
      : action === "deploy" || action === "release" ? "destructive"
      : "external_write",
    target: `${action}:672`,
    gate: { authority: "deterministic_policy", policy_ref: `handoff:${action}:v1` },
    gate_decision: "allow",
    outcome: "succeeded",
    audit_event_ref: `pi_action_events:672:${action}`,
    after_ref: `${action}:672:result`,
    rollback_ref: action === "commit" ? "git:base" : `rollback:${action}:672`
  }));
}

function context(): HandoffLinkContext {
  return {
    runs: [{ id: RUN_ID, work_id: WORK_ID }],
    evidence: [{ id: EVIDENCE_ID, status: "passed", work_id: WORK_ID }]
  };
}

function transition(
  handoff: HandoffRecord,
  to: Exclude<HandoffRecord["status"], "draft">
): HandoffTransitionCommand {
  return {
    audit: {
      actor: { id: "runner", kind: "runner" },
      correlation_id: "issue-672-handoff",
      event_id: `handoff-transition:${handoff.revision}:${to}`,
      gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "handoff-status:v1" },
      occurred_at: LATER,
      reason: `move Handoff to ${to}`
    },
    expected_revision: handoff.revision,
    handoff_id: handoff.id,
    to
  };
}
