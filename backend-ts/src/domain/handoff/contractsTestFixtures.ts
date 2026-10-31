import { resolve } from "node:path";

import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  type DeliveryMode,
  type HandoffDeliveryAction,
  type HandoffLinkContext,
  type HandoffRecord,
  type HandoffTransitionCommand
} from "./contracts.ts";

export const NOW = "2026-07-16T12:00:00.000Z";

export const LATER = "2026-07-16T12:01:00.000Z";

export const WORK_ID = makeDomainID("work", "issues", 672);

export const RUN_ID = makeDomainID("run", "issue_runs", "672:1");

export const EVIDENCE_ID = makeDomainID("evidence", "issue_events", "672:test");

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");

export const ADR_PATH = "docs/architecture/xuanwu/0036-handoff-delivery-contract.md";

export function record(mode: DeliveryMode, status: HandoffRecord["status"] = "ready"): HandoffRecord {
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

export function deliveryFor(mode: DeliveryMode): HandoffRecord["delivery"] {
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

export function finalRevision(delivery: HandoffRecord["delivery"]): string {
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

export function actionsFor(mode: DeliveryMode): HandoffDeliveryAction[] {
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

export function context(): HandoffLinkContext {
  return {
    runs: [{ id: RUN_ID, work_id: WORK_ID }],
    evidence: [{ id: EVIDENCE_ID, status: "passed", work_id: WORK_ID }]
  };
}

export function transition(
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
