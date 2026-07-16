import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  HANDOFF_STATUSES,
  STATE_TRANSITIONS,
  canTransition,
  parseDomainID,
  type DomainActor,
  type EvidenceID,
  type EvidenceStatus,
  type Handoff as CoreHandoff,
  type HandoffID,
  type HandoffStatus,
  type RunID,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";

export {
  HANDOFF_STATUSES,
  type EvidenceID,
  type HandoffID,
  type HandoffStatus,
  type RunID,
  type WorkID
};

export const HANDOFF_SCHEMA_VERSION = 1 as const;

// P00.04 remains the single source for the shared Handoff status vocabulary and edge table.
export const HANDOFF_STATE_TRANSITIONS = STATE_TRANSITIONS.handoff;

export const DELIVERY_MODES = [
  "local_changes",
  "branch_commit",
  "push",
  "draft_pr",
  "ready_pr",
  "deploy",
  "release"
] as const;
export type DeliveryMode = typeof DELIVERY_MODES[number];

export const REVIEW_STATES = [
  "not_requested",
  "pending",
  "approved",
  "changes_requested",
  "not_applicable"
] as const;
export type ReviewState = typeof REVIEW_STATES[number];

export const DELIVERY_ACTIONS = [
  "commit",
  "push",
  "pull_request",
  "deploy",
  "release",
  "tracker_update"
] as const;
export type DeliveryActionKind = typeof DELIVERY_ACTIONS[number];

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type RiskSeverity = typeof RISK_SEVERITIES[number];

export const ROLLBACK_AVAILABILITIES = ["not_required", "available", "blocked"] as const;
export type RollbackAvailability = typeof ROLLBACK_AVAILABILITIES[number];

const requiredText = Type.String({ minLength: 1, maxLength: 4096 });
const referenceText = Type.String({ minLength: 1, maxLength: 8192 });
const timestamp = Type.String({ minLength: 20, maxLength: 35 });
const workIDSchema = Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" });
const runIDSchema = Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+$" });
const evidenceIDSchema = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});
const handoffIDSchema = Type.String({ pattern: "^xw:handoff:derived:[A-Za-z0-9._~%-]+$" });

const actorSchema = Type.Object({
  id: requiredText,
  kind: Type.Union([
    Type.Literal("user"),
    Type.Literal("supervisor"),
    Type.Literal("runner"),
    Type.Literal("guardian"),
    Type.Literal("automation"),
    Type.Literal("system")
  ])
}, { additionalProperties: false });

const branchSchema = {
  branch_ref: referenceText,
  commit_ref: referenceText
};
const remoteSchema = {
  ...branchSchema,
  remote_ref: referenceText
};
const pullRequestSchema = {
  ...remoteSchema,
  pull_request_ref: referenceText,
  url: referenceText
};

const deliverySchema = Type.Union([
  Type.Object({
    mode: Type.Literal("local_changes"),
    working_tree_ref: referenceText
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("branch_commit"),
    ...branchSchema
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("push"),
    ...remoteSchema
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("draft_pr"),
    ...pullRequestSchema
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("ready_pr"),
    ...pullRequestSchema
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("deploy"),
    deployment_ref: referenceText,
    environment: requiredText,
    revision_ref: referenceText
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("release"),
    release_ref: referenceText,
    revision_ref: referenceText,
    version: requiredText
  }, { additionalProperties: false })
]);

const gateSchema = Type.Object({
  authority: Type.Union([Type.Literal("deterministic_policy"), Type.Literal("human_approval")]),
  policy_ref: requiredText
}, { additionalProperties: false });

export const HANDOFF_SCHEMA = Type.Object({
  schema_version: Type.Literal(HANDOFF_SCHEMA_VERSION),
  id: handoffIDSchema,
  work_id: workIDSchema,
  run_ids: Type.Array(runIDSchema, { maxItems: 256 }),
  evidence_ids: Type.Array(evidenceIDSchema, { maxItems: 256 }),
  supersedes_id: Type.Optional(handoffIDSchema),
  revision: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("ready"),
    Type.Literal("delivered"),
    Type.Literal("superseded")
  ]),
  summary: requiredText,
  created_at: timestamp,
  updated_at: timestamp,
  baseline_revision: referenceText,
  final_revision: referenceText,
  review_ref: referenceText,
  changed_files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 4096 }),
  delivery: deliverySchema,
  delivery_actions: Type.Array(Type.Object({
    action: Type.Union(DELIVERY_ACTIONS.map((action) => Type.Literal(action))),
    required: Type.Boolean(),
    classification: Type.Union([
      Type.Literal("state_change"),
      Type.Literal("external_write"),
      Type.Literal("destructive")
    ]),
    target: referenceText,
    gate: gateSchema,
    gate_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("ask")]),
    outcome: Type.Union([
      Type.Literal("not_executed"),
      Type.Literal("succeeded"),
      Type.Literal("failed")
    ]),
    audit_event_ref: referenceText,
    before_ref: Type.Optional(referenceText),
    after_ref: Type.Optional(referenceText),
    rollback_ref: Type.Optional(referenceText)
  }, { additionalProperties: false }), { maxItems: 64 }),
  risks: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" }),
    severity: Type.Union(RISK_SEVERITIES.map((severity) => Type.Literal(severity))),
    summary: requiredText,
    mitigation: requiredText,
    source_refs: Type.Array(referenceText, { maxItems: 64 })
  }, { additionalProperties: false }), { maxItems: 256 }),
  rollback: Type.Object({
    availability: Type.Union(ROLLBACK_AVAILABILITIES.map((availability) => Type.Literal(availability))),
    destructive: Type.Boolean(),
    plan: Type.Optional(requiredText),
    reason: Type.Optional(requiredText),
    refs: Type.Array(referenceText, { maxItems: 64 }),
    approval_policy_ref: Type.Optional(referenceText)
  }, { additionalProperties: false }),
  review: Type.Object({
    required: Type.Boolean(),
    state: Type.Union(REVIEW_STATES.map((state) => Type.Literal(state))),
    review_ref: Type.Optional(referenceText),
    reviewer_refs: Type.Array(referenceText, { maxItems: 64 }),
    decided_at: Type.Optional(timestamp)
  }, { additionalProperties: false })
}, { additionalProperties: false });

type HandoffSchemaValue = Static<typeof HANDOFF_SCHEMA>;
export type HandoffRecord = Omit<
  HandoffSchemaValue,
  "evidence_ids" | "id" | "run_ids" | "supersedes_id" | "work_id"
> & {
  evidence_ids: EvidenceID[];
  id: HandoffID;
  run_ids: RunID[];
  supersedes_id?: HandoffID;
  work_id: WorkID;
};
export type HandoffDelivery = HandoffRecord["delivery"];
export type HandoffDeliveryAction = HandoffRecord["delivery_actions"][number];
export type HandoffRisk = HandoffRecord["risks"][number];
export type HandoffRollback = HandoffRecord["rollback"];
export type HandoffReview = HandoffRecord["review"];

// The detailed P05 record remains assignable to the P00.04 cross-object skeleton.
export const HANDOFF_REFINES_CORE_CONTRACT: HandoffRecord extends CoreHandoff ? true : never = true;

export type HandoffLinkContext = {
  evidence: Array<{ id: EvidenceID; status: EvidenceStatus; work_id: WorkID }>;
  runs: Array<{ id: RunID; work_id: WorkID }>;
};

export type HandoffValidationResult = { errors: string[]; ok: boolean };

export type HandoffTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type HandoffTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: HandoffTransitionGate;
  occurred_at: string;
  reason: string;
};

export type HandoffTransitionCommand = {
  audit: HandoffTransitionAudit;
  expected_revision: number;
  handoff_id: HandoffID;
  superseding_handoff_id?: HandoffID;
  to: Exclude<HandoffStatus, "draft">;
};

export type HandoffTransitionDecision = { allowed: boolean; violations: string[] };

const REQUIRED_ACTIONS_BY_MODE: Readonly<Record<DeliveryMode, readonly DeliveryActionKind[]>> = {
  local_changes: [],
  branch_commit: ["commit"],
  push: ["commit", "push"],
  draft_pr: ["commit", "push", "pull_request"],
  ready_pr: ["commit", "push", "pull_request"],
  deploy: ["deploy"],
  release: ["release"]
};

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

function validateDelivery(handoff: HandoffRecord, errors: string[]): void {
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
    errors.push(`${delivery.mode} requires changed_files`);
  }
}

function validateLinks(handoff: HandoffRecord, context: HandoffLinkContext, errors: string[]): void {
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

function validateRisks(handoff: HandoffRecord, errors: string[]): void {
  validateUnique(handoff.risks.map((risk) => risk.id), "risk ids", errors);
  for (const risk of handoff.risks) validateUnique(risk.source_refs, `risk ${risk.id} source_refs`, errors);
}

function validateRollback(handoff: HandoffRecord, errors: string[]): void {
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

function validateReview(handoff: HandoffRecord, errors: string[]): void {
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

function validateDeliveryActions(handoff: HandoffRecord, errors: string[]): void {
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

function validateStatusRequirements(
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

function validateTransitionAudit(audit: HandoffTransitionAudit): string[] {
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

function validateUnique(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} must be unique`);
}

function isIsoTimestamp(value: string | undefined): value is string {
  if (!value || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
