import { Type } from "@sinclair/typebox";

export const HANDOFF_SCHEMA_VERSION = 1 as const;

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

export const ROLLBACK_AVAILABILITIES = ["not_required", "available", "blocked"] as const;

export const requiredText = Type.String({ minLength: 1, maxLength: 4096 });

export const referenceText = Type.String({ minLength: 1, maxLength: 8192 });

export const timestamp = Type.String({ minLength: 20, maxLength: 35 });

export const workIDSchema = Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" });

export const runIDSchema = Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+$" });

export const evidenceIDSchema = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});

export const handoffIDSchema = Type.String({ pattern: "^xw:handoff:derived:[A-Za-z0-9._~%-]+$" });

export const branchSchema = {
  branch_ref: referenceText,
  commit_ref: referenceText
};

export const remoteSchema = {
  ...branchSchema,
  remote_ref: referenceText
};

export const pullRequestSchema = {
  ...remoteSchema,
  pull_request_ref: referenceText,
  url: referenceText
};

export const deliverySchema = Type.Union([
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

export const gateSchema = Type.Object({
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
