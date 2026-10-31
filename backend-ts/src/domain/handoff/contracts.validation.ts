import { Value } from "@sinclair/typebox/value";
import { canTransition, parseDomainID, type HandoffStatus } from "../../xuanwu/coreDomainContracts.ts";
import { REQUIRED_ACTIONS_BY_MODE } from "./contracts.model.ts";
import type { HandoffLinkContext, HandoffValidationResult, HandoffRecord, HandoffTransitionCommand, HandoffTransitionDecision, HandoffTransitionAudit } from "./contracts.model.ts";
import { HANDOFF_SCHEMA } from "./contracts.schema.ts";

export function validateHandoff(input: unknown, context: HandoffLinkContext): HandoffValidationResult {
  if (!Value.Check(HANDOFF_SCHEMA, input)) {
    const errors = [...Value.Errors(HANDOFF_SCHEMA, input)].map((error) =>
      `schema ${error.path || "/"}: ${error.message}`
    );
    return { errors, ok: false };
  }

  const handoff = input as HandoffRecord;
  const errors: string[] = [];
  if (parseDomainID(handoff.id)?.kind !== "handoff") errors.push("id must be a supported Handoff id");
  if (parseDomainID(handoff.work_id)?.kind !== "work") errors.push("work_id must be a supported Work id");
  if (handoff.supersedes_id === handoff.id) errors.push("Handoff cannot supersede itself");
  if (!Number.isSafeInteger(handoff.revision) || handoff.revision < 0) errors.push("revision must be non-negative");

  for (const [field, value] of [
    ["created_at", handoff.created_at],
    ["updated_at", handoff.updated_at],
    ["review.decided_at", handoff.review.decided_at]
  ] as const) {
    if (value !== undefined && !isIsoTimestamp(value)) errors.push(`${field} must be an ISO timestamp`);
  }
  if (isIsoTimestamp(handoff.created_at) && isIsoTimestamp(handoff.updated_at) && handoff.created_at > handoff.updated_at) {
    errors.push("updated_at cannot precede created_at");
  }
  if (isIsoTimestamp(handoff.review.decided_at) && handoff.review.decided_at! > handoff.updated_at) {
    errors.push("review.decided_at cannot follow updated_at");
  }

  validateUnique(handoff.run_ids, "run_ids", errors);
  validateUnique(handoff.evidence_ids, "evidence_ids", errors);
  validateUnique(handoff.changed_files, "changed_files", errors);
  validateDelivery(handoff, errors);
  validateLinks(handoff, context, errors);
  validateRisks(handoff, errors);
  validateRollback(handoff, errors);
  validateReview(handoff, errors);
  validateDeliveryActions(handoff, errors);
  validateStatusRequirements(handoff, handoff.status, context, errors);
  return { errors: [...new Set(errors)], ok: errors.length === 0 };
}

export function evaluateHandoffTransition(
  current: HandoffRecord,
  context: HandoffLinkContext,
  command: HandoffTransitionCommand
): HandoffTransitionDecision {
  const violations = [...validateHandoff(current, context).errors];
  if (command.handoff_id !== current.id) violations.push("transition references another Handoff");
  if (command.expected_revision !== current.revision) violations.push("stale Handoff revision");
  if (!canTransition("handoff", current.status, command.to)) {
    violations.push(`illegal Handoff transition ${current.status} -> ${command.to}`);
  }
  violations.push(...validateTransitionAudit(command.audit));
  validateDelivery({ ...current, status: command.to }, violations);
  validateStatusRequirements(current, command.to, context, violations);

  if (command.to === "superseded") {
    if (!command.superseding_handoff_id) violations.push("superseded transition requires superseding_handoff_id");
    else if (command.superseding_handoff_id === current.id) violations.push("Handoff cannot supersede itself");
    else if (parseDomainID(command.superseding_handoff_id)?.kind !== "handoff") {
      violations.push("superseding_handoff_id must be a supported Handoff id");
    }
  } else if (command.superseding_handoff_id) {
    violations.push("superseding_handoff_id is only valid for superseded transitions");
  }

  return { allowed: violations.length === 0, violations: [...new Set(violations)] };
}

export function validateDelivery(handoff: HandoffRecord, errors: string[]): void {
  const delivery = handoff.delivery;
  if (delivery.mode === "local_changes" && delivery.working_tree_ref !== handoff.final_revision) {
    errors.push("local_changes working_tree_ref must equal final_revision");
  }
  if (["branch_commit", "push", "draft_pr", "ready_pr"].includes(delivery.mode) &&
    "commit_ref" in delivery && delivery.commit_ref !== handoff.final_revision) {
    errors.push(`${delivery.mode} commit_ref must equal final_revision`);
  }
  if (["deploy", "release"].includes(delivery.mode) &&
    "revision_ref" in delivery && delivery.revision_ref !== handoff.final_revision) {
    errors.push(`${delivery.mode} revision_ref must equal final_revision`);
  }
  if (["local_changes", "branch_commit", "push", "draft_pr", "ready_pr"].includes(delivery.mode) &&
    handoff.changed_files.length === 0) {
    const localObservationReceipt = delivery.mode === "local_changes"
      && (handoff.baseline_revision === handoff.final_revision || ["draft", "superseded"].includes(handoff.status))
      && handoff.delivery_actions.length === 0 && handoff.run_ids.length > 0 && handoff.evidence_ids.length > 0;
    if (!localObservationReceipt) errors.push(`${delivery.mode} requires changed_files or an unchanged read-only receipt`);
  }
}

export function validateLinks(handoff: HandoffRecord, context: HandoffLinkContext, errors: string[]): void {
  const runs = new Map(context.runs.map((run) => [run.id, run]));
  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  for (const runID of handoff.run_ids) {
    const run = runs.get(runID);
    if (!run) errors.push(`${runID} is not present in Handoff context`);
    else if (run.work_id !== handoff.work_id) errors.push(`${runID} Run belongs to another Work`);
  }
  for (const evidenceID of handoff.evidence_ids) {
    const item = evidence.get(evidenceID);
    if (!item) errors.push(`${evidenceID} is not present in Handoff context`);
    else if (item.work_id !== handoff.work_id) errors.push(`${evidenceID} Evidence belongs to another Work`);
  }
}

export function validateRisks(handoff: HandoffRecord, errors: string[]): void {
  validateUnique(handoff.risks.map((risk) => risk.id), "risk ids", errors);
  for (const risk of handoff.risks) validateUnique(risk.source_refs, `risk ${risk.id} source_refs`, errors);
}

export function validateRollback(handoff: HandoffRecord, errors: string[]): void {
  const rollback = handoff.rollback;
  validateUnique(rollback.refs, "rollback refs", errors);
  if (rollback.availability === "available" && !rollback.plan?.trim()) {
    errors.push("available rollback requires a plan");
  }
  if (rollback.availability === "blocked" && !rollback.reason?.trim()) {
    errors.push("blocked rollback requires a reason");
  }
  if (rollback.availability === "blocked" && handoff.risks.length === 0) {
    errors.push("blocked rollback requires a recorded risk");
  }
  if (rollback.destructive && !rollback.approval_policy_ref?.trim()) {
    errors.push("destructive rollback requires approval_policy_ref");
  }
  if (handoff.delivery.mode !== "local_changes" && rollback.availability === "not_required") {
    errors.push(`${handoff.delivery.mode} must define an available or blocked rollback`);
  }
}

export function validateReview(handoff: HandoffRecord, errors: string[]): void {
  const review = handoff.review;
  validateUnique(review.reviewer_refs, "reviewer_refs", errors);
  if (review.required && review.state === "not_applicable") errors.push("required review cannot be not_applicable");
  if (["pending", "approved", "changes_requested"].includes(review.state) && !review.review_ref?.trim()) {
    errors.push(`${review.state} review requires review_ref`);
  }
  if (["approved", "changes_requested"].includes(review.state) && !review.decided_at) {
    errors.push(`${review.state} review requires decided_at`);
  }
  if (handoff.delivery.mode === "ready_pr" && ["not_requested", "not_applicable"].includes(review.state)) {
    errors.push("ready_pr requires an active review state");
  }
  if ((handoff.delivery.mode === "draft_pr" || handoff.delivery.mode === "ready_pr") &&
    review.review_ref && review.review_ref !== handoff.delivery.pull_request_ref) {
    errors.push("PR review_ref must equal pull_request_ref");
  }
  if (review.review_ref && review.review_ref !== handoff.review_ref) {
    errors.push("structured review_ref must equal core review_ref");
  }
}

export function validateDeliveryActions(handoff: HandoffRecord, errors: string[]): void {
  const keys = handoff.delivery_actions.map((action) => `${action.action}:${action.target}`);
  validateUnique(keys, "delivery actions", errors);
  const requiredActions = REQUIRED_ACTIONS_BY_MODE[handoff.delivery.mode];
  for (const actionKind of requiredActions) {
    if (!handoff.delivery_actions.some((action) => action.action === actionKind && action.required)) {
      errors.push(`${handoff.delivery.mode} requires a required ${actionKind} delivery action`);
    }
  }

  for (const action of handoff.delivery_actions) {
    if (action.outcome !== "not_executed" && action.gate_decision !== "allow") {
      errors.push(`${action.action} cannot execute without an allow gate`);
    }
    if (action.outcome === "succeeded" && !action.after_ref?.trim()) {
      errors.push(`succeeded ${action.action} requires after_ref`);
    }
    if (action.action === "commit" && action.classification !== "state_change") {
      errors.push("commit delivery action must be a state_change");
    }
    if (["push", "pull_request", "tracker_update"].includes(action.action) && action.classification !== "external_write") {
      errors.push(`${action.action} delivery action must be an external_write`);
    }
    if (["deploy", "release"].includes(action.action) && action.classification === "state_change") {
      errors.push(`${action.action} delivery action must be an external_write or destructive operation`);
    }
  }
}

export function validateStatusRequirements(
  handoff: HandoffRecord,
  status: HandoffStatus,
  context: HandoffLinkContext,
  errors: string[]
): void {
  if (status === "ready" || status === "delivered") {
    const evidence = new Map(context.evidence.map((item) => [item.id, item]));
    if (!handoff.evidence_ids.some((id) => evidence.get(id)?.status === "passed")) {
      errors.push(`${status} Handoff requires passed Evidence`);
    }
    if (handoff.review.state === "changes_requested") {
      errors.push(`${status} Handoff cannot have changes_requested review`);
    }
  }
  if (status === "delivered") {
    for (const action of handoff.delivery_actions.filter((item) => item.required)) {
      if (action.outcome !== "succeeded") errors.push(`delivered Handoff requires ${action.action} to succeed`);
    }
    if (handoff.review.required && handoff.review.state !== "approved") {
      errors.push("delivered Handoff with required review must be approved");
    }
  }
}

export function validateTransitionAudit(audit: HandoffTransitionAudit): string[] {
  const errors: string[] = [];
  if (!audit.event_id.trim()) errors.push("transition event_id is required");
  if (!audit.actor.id.trim()) errors.push("transition actor.id is required");
  if (!audit.reason.trim()) errors.push("transition reason is required");
  if (!audit.correlation_id.trim()) errors.push("transition correlation_id is required");
  if (!isIsoTimestamp(audit.occurred_at)) errors.push("transition occurred_at must be an ISO timestamp");
  if (!audit.gate.policy_ref.trim()) errors.push("transition policy_ref is required");
  if (audit.gate.decision !== "allow") errors.push("transition gate requires approval");
  if (!["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    errors.push("transition gate authority is not trusted");
  }
  return errors;
}

export function validateUnique(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} must be unique`);
}

export function isIsoTimestamp(value: string | undefined): value is string {
  if (!value || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
