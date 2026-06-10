import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const PI_SUPERVISOR_DIAGNOSIS_CODES = [
  "executor_stream_disconnected",
  "provider_rate_limited",
  "provider_retry_after_waiting",
  "provider_retry_after_ready",
  "provider_transient_network_error",
  "session_no_recent_progress",
  "session_recovery_exhausted",
  "requires_human_decision"
] as const;

export const PI_SUPERVISOR_DECISIONS = [
  "wait",
  "resume_session",
  "steer_running_turn",
  "retry_issue",
  "needs_user",
  "blocked",
  "noop"
] as const;

export const PI_SUPERVISOR_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export const PI_SUPERVISOR_RISK_LEVELS = ["low", "medium", "high"] as const;
export const PI_SUPERVISOR_RATE_LIMIT_WAIT_POLICIES = ["respect_retry_after", "default_cooldown", "ask"] as const;
export const PI_SUPERVISOR_MODES = ["off", "propose_only", "assisted", "autonomous"] as const;

export type PiSupervisorDiagnosisCode = typeof PI_SUPERVISOR_DIAGNOSIS_CODES[number];
export type PiSupervisorDecision = typeof PI_SUPERVISOR_DECISIONS[number];
export type PiSupervisorMode = typeof PI_SUPERVISOR_MODES[number];
export type PiSupervisorRateLimitWaitPolicy = typeof PI_SUPERVISOR_RATE_LIMIT_WAIT_POLICIES[number];

const stringArray = Type.Array(Type.String({ minLength: 1 }));
const positiveInteger = Type.Integer({ minimum: 1 });
const optionalText = Type.Optional(Type.String());
const decisionEnum = literalUnion(PI_SUPERVISOR_DECISIONS);
const confidenceEnum = literalUnion(PI_SUPERVISOR_CONFIDENCE_LEVELS);
const diagnosisEnum = literalUnion(PI_SUPERVISOR_DIAGNOSIS_CODES);
const fallbackEnum = literalUnion(["needs_user", "retry_issue", "blocked"] as const);
const riskEnum = literalUnion(PI_SUPERVISOR_RISK_LEVELS);

export const PI_SUPERVISOR_DECISION_JSON_SCHEMA = Type.Object({
  confidence: confidenceEnum,
  decision: decisionEnum,
  evidence_refs: stringArray,
  expected_outcome: Type.String({ minLength: 1 }),
  fallback_if_no_progress: fallbackEnum,
  rationale: Type.String({ minLength: 1 }),
  recovery_message: optionalText,
  risk_level: riskEnum,
  wait_until: optionalText
}, { additionalProperties: false });

export type PiSupervisorDecisionJson = Static<typeof PI_SUPERVISOR_DECISION_JSON_SCHEMA>;

export const PI_SUPERVISOR_ACTION_PAYLOAD_SCHEMAS = {
  "issue.retry": Type.Object({
    decision_id: Type.String({ minLength: 1 }),
    diagnosis_code: diagnosisEnum,
    issue_id: positiveInteger,
    reason: optionalText
  }, { additionalProperties: false }),
  "issue.retry_after": Type.Object({
    decision_id: optionalText,
    diagnosis_code: optionalText,
    issue_id: positiveInteger,
    reason: Type.String({ minLength: 1 }),
    retry_after_at: Type.String({ minLength: 1 }),
    source_event_id: Type.Optional(positiveInteger)
  }, { additionalProperties: false }),
  "issue.supervisor_decision": Type.Object({
    decision: PI_SUPERVISOR_DECISION_JSON_SCHEMA,
    issue_id: positiveInteger
  }, { additionalProperties: false }),
  "needs_user.escalate": Type.Object({
    decision_id: Type.String({ minLength: 1 }),
    diagnosis_code: diagnosisEnum,
    issue_id: positiveInteger,
    message: Type.String({ minLength: 1 }),
    reason: optionalText
  }, { additionalProperties: false }),
  "session.resume_followup": Type.Object({
    decision_id: Type.String({ minLength: 1 }),
    diagnosis_code: diagnosisEnum,
    issue_id: positiveInteger,
    prompt: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    provider_session_id: Type.String({ minLength: 1 }),
    provider_turn_id: optionalText
  }, { additionalProperties: false }),
  "session.steer": Type.Object({
    decision_id: Type.String({ minLength: 1 }),
    diagnosis_code: diagnosisEnum,
    issue_id: positiveInteger,
    prompt: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    provider_session_id: Type.String({ minLength: 1 }),
    provider_turn_id: Type.String({ minLength: 1 })
  }, { additionalProperties: false })
} satisfies Record<string, TSchema>;

export const PI_SUPERVISOR_DECISION_ACTION_TYPES: Record<PiSupervisorDecision, string[]> = {
  blocked: ["needs_user.escalate"],
  needs_user: ["needs_user.escalate"],
  noop: ["issue.supervisor_decision"],
  resume_session: ["session.resume_followup"],
  retry_issue: ["issue.retry"],
  steer_running_turn: ["session.steer"],
  wait: ["issue.retry_after"]
};

function literalUnion<const T extends readonly string[]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [
    ReturnType<typeof Type.Literal>,
    ReturnType<typeof Type.Literal>,
    ...Array<ReturnType<typeof Type.Literal>>
  ]);
}
