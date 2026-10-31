import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  DELIVERY_MODES,
  HANDOFF_SCHEMA,
  REVIEW_STATES,
  evaluateHandoffTransition,
  validateHandoff,
  type DeliveryMode,
  type HandoffRecord,
  type HandoffTransitionCommand
} from "./contracts.ts";
import {
  LATER,
  RUN_ID,
  EVIDENCE_ID,
  REPO_ROOT,
  ADR_PATH,
  record,
  context,
  transition
} from "./contractsTestFixtures.ts";

export function registerContractsValidationCases() {
  test("publishes every delivery mode and review state", () => {
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

  test("zero-file drafts can preserve different observations but cannot promote them to a ready receipt", () => {
    const handoff = record("local_changes");
    handoff.status = "draft";
    handoff.changed_files = [];
    expect(validateHandoff(handoff, context()).ok).toBe(true);
    expect(evaluateHandoffTransition(handoff, context(), transition(handoff, "ready")).allowed).toBe(false);
    expect(evaluateHandoffTransition(handoff, context(), {
      ...transition(handoff, "superseded"), superseding_handoff_id: makeDomainID("handoff", "derived", "replacement"),
    }).allowed).toBe(true);
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
}
