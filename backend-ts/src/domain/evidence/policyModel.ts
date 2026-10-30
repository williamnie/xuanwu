import { Type, type Static } from "@sinclair/typebox";
import { type EvidenceID, type RunID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import { type EvidenceKind, type EvidenceRecord, type RunAttemptID } from "./contracts.ts";

export const VERIFICATION_POLICY_SCHEMA_VERSION = 1 as const;

export const VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION = 1 as const;

export const VERIFICATION_RISK_LEVELS = ["safe", "confirm", "high", "forbidden"] as const;

export type VerificationRiskLevel = typeof VERIFICATION_RISK_LEVELS[number];

const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" });

const requiredText = Type.String({ minLength: 1, maxLength: 4096 });

const policyID = Type.String({ pattern: "^verification-policy:[a-z][a-z0-9._-]{0,127}$" });

const evidenceKind = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" });

const scalar = Type.Union([Type.String({ maxLength: 8192 }), Type.Number(), Type.Boolean(), Type.Null()]);

const factKey = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" });

const factAssertionSchema = Type.Object({
  key: factKey,
  operator: Type.Union([
    Type.Literal("equals"),
    Type.Literal("not_equals"),
    Type.Literal("truthy"),
    Type.Literal("falsy")
  ]),
  expected: Type.Optional(scalar)
}, { additionalProperties: false });

const skipPolicySchema = Type.Object({
  allowed_reason_codes: Type.Array(id, { minItems: 1, maxItems: 32 }),
  requires_human_evidence: Type.Literal(true)
}, { additionalProperties: false });

const evidenceRequirementSchema = Type.Object({
  id,
  evidence_kinds: Type.Array(evidenceKind, { minItems: 1, maxItems: 16 }),
  scope: Type.Union([Type.Literal("work"), Type.Literal("run"), Type.Literal("attempt")]),
  selector_facts: Type.Optional(Type.Record(factKey, scalar)),
  fact_assertions: Type.Array(factAssertionSchema, { maxItems: 32 }),
  max_age_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 * 24 * 60 * 60 })),
  artifact_policy: Type.Union([
    Type.Literal("ignore"),
    Type.Literal("present"),
    Type.Literal("available")
  ]),
  skip: Type.Optional(skipPolicySchema)
}, { additionalProperties: false });

const evidenceGroupSchema = Type.Object({
  id,
  operator: Type.Union([Type.Literal("all"), Type.Literal("any")]),
  requirements: Type.Array(evidenceRequirementSchema, { minItems: 1, maxItems: 64 })
}, { additionalProperties: false });

const kindRuleSchema = Type.Object({
  kind: evidenceKind,
  allowed_assertion_origins: Type.Array(Type.Union([
    Type.Literal("tool_result"),
    Type.Literal("system_observation")
  ]), { minItems: 1, maxItems: 2 }),
  allowed_source_kinds: Type.Array(Type.Union([
    Type.Literal("command_execution"),
    Type.Literal("test_runner"),
    Type.Literal("linter"),
    Type.Literal("build_system"),
    Type.Literal("git_repository"),
    Type.Literal("http_exchange"),
    Type.Literal("browser_session")
  ]), { minItems: 1, maxItems: 8 })
}, { additionalProperties: false });

const riskOverrideSchema = Type.Object({
  risk: Type.Union([
    Type.Literal("safe"),
    Type.Literal("confirm"),
    Type.Literal("high"),
    Type.Literal("forbidden")
  ]),
  additional_required_groups: Type.Array(evidenceGroupSchema, { maxItems: 32 }),
  manual_override: Type.Union([
    Type.Literal("deny"),
    Type.Literal("allow_with_human_evidence")
  ])
}, { additionalProperties: false });

export const VERIFICATION_POLICY_SCHEMA = Type.Object({
  schema_version: Type.Literal(VERIFICATION_POLICY_SCHEMA_VERSION),
  id: policyID,
  revision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  kind_rules: Type.Array(kindRuleSchema, { maxItems: 32 }),
  required_groups: Type.Array(evidenceGroupSchema, { minItems: 1, maxItems: 64 }),
  optional_requirements: Type.Array(evidenceRequirementSchema, { maxItems: 64 }),
  risk_overrides: Type.Array(riskOverrideSchema, { maxItems: VERIFICATION_RISK_LEVELS.length })
}, { additionalProperties: false });

export const PROJECT_VERIFICATION_OVERRIDE_SCHEMA = Type.Object({
  schema_version: Type.Literal(VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION),
  project_id: requiredText,
  policy_id: policyID,
  base_policy_revision: Type.Integer({ minimum: 1 }),
  additional_required_groups: Type.Array(evidenceGroupSchema, { maxItems: 64 }),
  promote_optional_requirement_ids: Type.Array(id, { maxItems: 64 }),
  disallow_skip_requirement_ids: Type.Array(id, { maxItems: 64 }),
  deny_manual_override: Type.Boolean(),
  audit_event_ref: requiredText
}, { additionalProperties: false });

type VerificationPolicySchemaValue = Static<typeof VERIFICATION_POLICY_SCHEMA>;

type ProjectVerificationOverrideSchemaValue = Static<typeof PROJECT_VERIFICATION_OVERRIDE_SCHEMA>;

export type EvidenceFactAssertion = Static<typeof factAssertionSchema>;

export type EvidenceRequirement = Omit<Static<typeof evidenceRequirementSchema>, "evidence_kinds"> & {
  evidence_kinds: EvidenceKind[];
};

export type EvidenceRequirementGroup = Omit<Static<typeof evidenceGroupSchema>, "requirements"> & {
  requirements: EvidenceRequirement[];
};

export type VerificationKindRule = Omit<Static<typeof kindRuleSchema>, "kind"> & { kind: EvidenceKind };

type VerificationRiskOverride = Omit<Static<typeof riskOverrideSchema>, "additional_required_groups"> & {
  additional_required_groups: EvidenceRequirementGroup[];
};

export type WorkflowVerificationPolicy = Omit<
  VerificationPolicySchemaValue,
  "kind_rules" | "optional_requirements" | "required_groups" | "risk_overrides"
> & {
  kind_rules: VerificationKindRule[];
  optional_requirements: EvidenceRequirement[];
  required_groups: EvidenceRequirementGroup[];
  risk_overrides: VerificationRiskOverride[];
};

export type ProjectVerificationOverride = Omit<
  ProjectVerificationOverrideSchemaValue,
  "additional_required_groups"
> & { additional_required_groups: EvidenceRequirementGroup[] };

export type VerificationSkipDecision = {
  audit_event_ref: string;
  human_evidence_id: EvidenceID;
  reason: string;
  reason_code: string;
  requirement_id: string;
};

export type VerificationManualOverride = {
  audit_event_ref: string;
  human_evidence_id: EvidenceID;
  reason: string;
};

export type VerificationEvaluationContext = {
  attempt_id?: RunAttemptID;
  now: string;
  project_id: string;
  risk: VerificationRiskLevel;
  run_id?: RunID;
  work_id: WorkID;
};

export type EvaluateVerificationPolicyInput = {
  artifact_availability?: Readonly<Record<string, boolean>>;
  context: VerificationEvaluationContext;
  evidence: readonly EvidenceRecord[];
  manual_override?: VerificationManualOverride;
  policy: WorkflowVerificationPolicy;
  project_override?: ProjectVerificationOverride;
  skip_decisions?: readonly VerificationSkipDecision[];
};

export type VerificationRequirementStatus = "passed" | "skipped" | "missing" | "pending" | "failed";

export type VerificationRequirementResult = {
  evidence_id?: EvidenceID;
  reason: string;
  requirement_id: string;
  status: VerificationRequirementStatus;
};

export type VerificationGroupResult = {
  group_id: string;
  operator: "all" | "any";
  requirements: VerificationRequirementResult[];
  status: "passed" | "pending" | "failed";
};

export type VerificationOverrideResult = {
  applied: boolean;
  evidence_id?: EvidenceID;
  reasons: string[];
};

export type VerificationPolicyDecision = "passed" | "pending" | "failed" | "overridden" | "invalid";

export type VerificationPolicyEvaluation = {
  applied_project_override: boolean;
  applied_risk_override: boolean;
  decision: VerificationPolicyDecision;
  errors: string[];
  groups: VerificationGroupResult[];
  optional_requirements: VerificationRequirementResult[];
  override: VerificationOverrideResult;
  policy_ref: string;
  satisfied: boolean;
};

export type VerificationContractValidation = { errors: string[]; ok: boolean };

export type EffectivePolicy = {
  groups: EvidenceRequirementGroup[];
  kindRules: Map<string, VerificationKindRule>;
  manualOverride: "deny" | "allow_with_human_evidence";
  optionalRequirements: EvidenceRequirement[];
};

export type EvidenceIndex = {
  active: EvidenceRecord[];
};
