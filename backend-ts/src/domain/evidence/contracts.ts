import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  EVIDENCE_STATUSES,
  STATE_TRANSITIONS,
  canTransition,
  parseDomainID,
  type DomainActor,
  type EvidenceID,
  type EvidenceStatus,
  type RunID,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";
import type { RunAttemptID } from "../run/contracts.ts";

export { EVIDENCE_STATUSES, type EvidenceID, type EvidenceStatus, type RunID, type RunAttemptID, type WorkID };

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

// P00.04 remains the single source for the shared Evidence status vocabulary and edge table.
export const EVIDENCE_STATE_TRANSITIONS = STATE_TRANSITIONS.evidence;

export const EVIDENCE_KINDS = ["shell", "test", "lint", "build", "git", "http", "browser", "human"] as const;
export type KnownEvidenceKind = typeof EVIDENCE_KINDS[number];
// Well-formed future kinds remain readable. A verification policy must explicitly register them before they can pass a gate.
export type EvidenceKind = KnownEvidenceKind | (string & {});

export const EVIDENCE_SOURCE_KINDS = [
  "command_execution",
  "test_runner",
  "linter",
  "build_system",
  "git_repository",
  "http_exchange",
  "browser_session",
  "human_attestation",
  "agent_statement",
  "legacy_verification"
] as const;
export type EvidenceSourceKind = typeof EVIDENCE_SOURCE_KINDS[number];

export const EVIDENCE_ASSERTION_ORIGINS = [
  "tool_result",
  "system_observation",
  "human_attestation",
  "agent_claim",
  "legacy_import"
] as const;
export type EvidenceAssertionOrigin = typeof EVIDENCE_ASSERTION_ORIGINS[number];

export const EVIDENCE_ARTIFACT_KINDS = ["log", "report", "screenshot", "trace", "diff", "commit", "url", "file", "other"] as const;
export type EvidenceArtifactKind = typeof EVIDENCE_ARTIFACT_KINDS[number];

export const EVIDENCE_REDACTION_STATUSES = ["not_required", "applied"] as const;
export type EvidenceRedactionStatus = typeof EVIDENCE_REDACTION_STATUSES[number];

const requiredText = Type.String({ minLength: 1, maxLength: 4096 });
const timestamp = Type.String({ minLength: 20, maxLength: 35 });
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
const scalarFactSchema = Type.Union([Type.String({ maxLength: 8192 }), Type.Number(), Type.Boolean(), Type.Null()]);

export const EVIDENCE_SCHEMA = Type.Object({
  schema_version: Type.Literal(EVIDENCE_SCHEMA_VERSION),
  id: Type.String({ pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$" }),
  work_id: Type.String({ pattern: "^xw:work:issues:[A-Za-z0-9._~%-]+$" }),
  run_id: Type.Optional(Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+$" })),
  attempt_id: Type.Optional(Type.String({ pattern: "^xw:run:issue_runs:[A-Za-z0-9._~%-]+~attempt:[1-9][0-9]*$" })),
  supersedes_id: Type.Optional(Type.String({ pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$" })),
  revision: Type.Integer({ minimum: 0 }),
  kind: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("blocked")
  ]),
  created_at: timestamp,
  observed_at: timestamp,
  updated_at: timestamp,
  completed_at: Type.Optional(timestamp),
  decisive_output: Type.Object({
    summary: requiredText,
    excerpt: Type.Optional(Type.String({ maxLength: 8192 })),
    exit_code: Type.Optional(Type.Integer()),
    facts: Type.Record(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" }), scalarFactSchema)
  }, { additionalProperties: false }),
  artifact_refs: Type.Array(Type.Object({
    kind: Type.Union([
      Type.Literal("log"),
      Type.Literal("report"),
      Type.Literal("screenshot"),
      Type.Literal("trace"),
      Type.Literal("diff"),
      Type.Literal("commit"),
      Type.Literal("url"),
      Type.Literal("file"),
      Type.Literal("other")
    ]),
    ref: requiredText,
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    media_type: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" }))
  }, { additionalProperties: false }), { maxItems: 256 }),
  provenance: Type.Object({
    assertion_origin: Type.Union([
      Type.Literal("tool_result"),
      Type.Literal("system_observation"),
      Type.Literal("human_attestation"),
      Type.Literal("agent_claim"),
      Type.Literal("legacy_import")
    ]),
    source_kind: Type.Union([
      Type.Literal("command_execution"),
      Type.Literal("test_runner"),
      Type.Literal("linter"),
      Type.Literal("build_system"),
      Type.Literal("git_repository"),
      Type.Literal("http_exchange"),
      Type.Literal("browser_session"),
      Type.Literal("human_attestation"),
      Type.Literal("agent_statement"),
      Type.Literal("legacy_verification")
    ]),
    source_ref: requiredText,
    audit_event_ref: requiredText,
    producer: actorSchema
  }, { additionalProperties: false }),
  redaction: Type.Object({
    status: Type.Union([Type.Literal("not_required"), Type.Literal("applied")]),
    policy_ref: requiredText,
    redacted_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 256 })
  }, { additionalProperties: false })
}, { additionalProperties: false });

type EvidenceSchemaValue = Static<typeof EVIDENCE_SCHEMA>;
export type EvidenceRecord = Omit<EvidenceSchemaValue, "attempt_id" | "id" | "kind" | "run_id" | "supersedes_id" | "work_id"> & {
  attempt_id?: RunAttemptID;
  id: EvidenceID;
  kind: EvidenceKind;
  run_id?: RunID;
  supersedes_id?: EvidenceID;
  work_id: WorkID;
};
export type EvidenceArtifactRef = EvidenceRecord["artifact_refs"][number];
export type EvidenceDecisiveOutput = EvidenceRecord["decisive_output"];
export type EvidenceProvenance = EvidenceRecord["provenance"];
export type EvidenceRedaction = EvidenceRecord["redaction"];
export type EvidenceValidationResult = { errors: string[]; known_kind: boolean; ok: boolean };

export type EvidenceTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type EvidenceTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: EvidenceTransitionGate;
  occurred_at: string;
  reason: string;
};

export type EvidenceTransitionCommand = {
  audit: EvidenceTransitionAudit;
  completed_at: string;
  evidence_id: EvidenceID;
  expected_revision: number;
  to: Exclude<EvidenceStatus, "pending">;
};

export type EvidenceTransitionDecision = { allowed: boolean; violations: string[] };

const TRUSTED_ASSERTION_ORIGINS = new Set<EvidenceAssertionOrigin>([
  "tool_result",
  "system_observation",
  "human_attestation"
]);
const SENSITIVE_FACT_KEY = /(?:^|[_.-])(authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key)(?:$|[_.-])/i;
const SECRET_PHRASE_PATTERN = /\b(token|secret|password|api[_-]?key|access[_-]?key)\b\s+(?:is\s+|was\s+)?(?!\[redacted\])[^\s,;]+/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:access_token|token|secret|password|api[_-]?key|access[_-]?key)=)(?!\[redacted\])[^&#\s]*/gi;

const TRUSTED_SOURCES_BY_KIND: Readonly<Record<KnownEvidenceKind, readonly EvidenceSourceKind[]>> = {
  shell: ["command_execution"],
  test: ["test_runner", "command_execution"],
  lint: ["linter", "command_execution"],
  build: ["build_system", "command_execution"],
  git: ["git_repository"],
  http: ["http_exchange"],
  browser: ["browser_session"],
  human: ["human_attestation"]
};

export function isKnownEvidenceKind(kind: string): kind is KnownEvidenceKind {
  return EVIDENCE_KINDS.includes(kind as KnownEvidenceKind);
}

export function validateEvidence(input: unknown): EvidenceValidationResult {
  const knownKind = isRecord(input) && typeof input.kind === "string" && isKnownEvidenceKind(input.kind);
  if (!Value.Check(EVIDENCE_SCHEMA, input)) {
    const errors = [...Value.Errors(EVIDENCE_SCHEMA, input)].map((error) =>
      `schema ${error.path || "/"}: ${error.message}`
    );
    return { errors, known_kind: knownKind, ok: false };
  }

  const evidence = input as EvidenceRecord;
  const errors: string[] = [];
  if (parseDomainID(evidence.id)?.kind !== "evidence") errors.push("id must be a supported Evidence id");
  if (parseDomainID(evidence.work_id)?.kind !== "work") errors.push("work_id must be a supported Work id");
  if (evidence.run_id && parseDomainID(evidence.run_id)?.kind !== "run") errors.push("run_id must be a supported Run id");
  if (evidence.supersedes_id === evidence.id) errors.push("Evidence cannot supersede itself");
  if (evidence.attempt_id && !evidence.run_id) errors.push("attempt_id requires run_id");
  if (evidence.attempt_id && evidence.run_id && !evidence.attempt_id.startsWith(`${evidence.run_id}~attempt:`)) {
    errors.push("attempt_id must belong to run_id");
  }

  for (const [field, value] of [
    ["created_at", evidence.created_at],
    ["observed_at", evidence.observed_at],
    ["updated_at", evidence.updated_at],
    ["completed_at", evidence.completed_at]
  ] as const) {
    if (value !== undefined && !isIsoTimestamp(value)) errors.push(`${field} must be an ISO timestamp`);
  }
  if (isIsoTimestamp(evidence.created_at) && isIsoTimestamp(evidence.updated_at) && evidence.created_at > evidence.updated_at) {
    errors.push("updated_at cannot precede created_at");
  }
  if (evidence.status === "pending" && evidence.completed_at) errors.push("pending Evidence cannot have completed_at");
  if (evidence.status !== "pending" && !evidence.completed_at) errors.push("terminal Evidence requires completed_at");
  if (isIsoTimestamp(evidence.completed_at) && isIsoTimestamp(evidence.observed_at) && evidence.completed_at < evidence.observed_at) {
    errors.push("completed_at cannot precede observed_at");
  }
  if (isIsoTimestamp(evidence.completed_at) && isIsoTimestamp(evidence.updated_at) && evidence.completed_at > evidence.updated_at) {
    errors.push("updated_at cannot precede completed_at");
  }

  if (knownKind && TRUSTED_ASSERTION_ORIGINS.has(evidence.provenance.assertion_origin)) {
    const allowedSources = TRUSTED_SOURCES_BY_KIND[evidence.kind as KnownEvidenceKind];
    if (!allowedSources.includes(evidence.provenance.source_kind)) {
      errors.push(`${evidence.kind} Evidence cannot trust source ${evidence.provenance.source_kind}`);
    }
  }
  if (evidence.provenance.assertion_origin === "human_attestation" && evidence.kind !== "human") {
    errors.push("human_attestation origin requires human Evidence kind");
  }
  if (evidence.provenance.assertion_origin === "agent_claim" && evidence.provenance.source_kind !== "agent_statement") {
    errors.push("agent_claim origin requires agent_statement source");
  }

  for (const key of Object.keys(evidence.decisive_output.facts)) {
    if (SENSITIVE_FACT_KEY.test(key)) errors.push(`sensitive decisive_output fact key is forbidden: ${key}`);
  }
  const sensitivePaths = findSensitivePaths(evidence);
  for (const path of sensitivePaths) errors.push(`unredacted sensitive value at ${path}`);
  const redactedPaths = evidence.redaction.redacted_paths;
  if (new Set(redactedPaths).size !== redactedPaths.length) errors.push("redacted_paths must be unique");
  for (const path of redactedPaths) {
    const redactedValue = valueAtPointer(evidence, path);
    if (typeof redactedValue !== "string" || !redactedValue.toLowerCase().includes("[redacted")) {
      errors.push(`redacted path does not reference a redacted string: ${path}`);
    }
  }
  if (evidence.redaction.status === "not_required" && redactedPaths.length > 0) {
    errors.push("not_required redaction cannot list redacted_paths");
  }
  if (evidence.redaction.status === "applied" && redactedPaths.length === 0) {
    errors.push("applied redaction requires redacted_paths");
  }
  const artifactRefs = evidence.artifact_refs.map((artifact) => artifact.ref);
  if (new Set(artifactRefs).size !== artifactRefs.length) errors.push("artifact refs must be unique");
  return { errors, known_kind: knownKind, ok: errors.length === 0 };
}

export function canSatisfyEvidenceGate(evidence: EvidenceRecord): boolean {
  const validation = validateEvidence(evidence);
  return validation.ok
    && validation.known_kind
    && evidence.status === "passed"
    && TRUSTED_ASSERTION_ORIGINS.has(evidence.provenance.assertion_origin);
}

export function evaluateEvidenceTransition(
  current: EvidenceRecord,
  command: EvidenceTransitionCommand
): EvidenceTransitionDecision {
  const violations: string[] = [];
  if (command.evidence_id !== current.id) violations.push("transition references another Evidence");
  if (command.expected_revision !== current.revision) violations.push("stale Evidence revision");
  if (!canTransition("evidence", current.status, command.to)) {
    violations.push(`illegal Evidence transition ${current.status} -> ${command.to}`);
  }
  if (!isIsoTimestamp(command.completed_at)) violations.push("transition completed_at must be an ISO timestamp");
  if (!isIsoTimestamp(command.audit.occurred_at)) violations.push("transition audit occurred_at must be an ISO timestamp");
  if (!command.audit.actor.id.trim()) violations.push("transition actor is required");
  if (!command.audit.correlation_id.trim()) violations.push("transition correlation_id is required");
  if (!command.audit.event_id.trim()) violations.push("transition event_id is required");
  if (!command.audit.reason.trim()) violations.push("transition reason is required");
  if (!command.audit.gate.policy_ref.trim()) violations.push("transition policy_ref is required");
  if (command.audit.gate.decision !== "allow") violations.push("transition gate requires approval");
  if (!["deterministic_policy", "human_approval"].includes(command.audit.gate.authority)) {
    violations.push("transition gate authority is not trusted");
  }
  return { allowed: violations.length === 0, violations };
}

export function redactEvidenceRecord(input: EvidenceRecord, policyRef: string): EvidenceRecord {
  const paths: string[] = [];
  const { redaction: _redaction, ...payload } = input;
  const output = redactValue(payload, "", paths) as Omit<EvidenceRecord, "redaction">;
  const cleanPolicyRef = redactEvidenceText(policyRef);
  if (cleanPolicyRef !== policyRef) paths.push("/redaction/policy_ref");
  const redactedPaths = [...new Set(paths)].sort();
  return {
    ...output,
    redaction: {
      policy_ref: cleanPolicyRef,
      redacted_paths: redactedPaths,
      status: redactedPaths.length > 0 ? "applied" : "not_required"
    }
  };
}

export function redactEvidenceText(value: string): string {
  return redactSensitiveText(value)
    .replace(SECRET_PHRASE_PATTERN, (_match, label: string) => `${label} [redacted]`)
    .replace(SENSITIVE_QUERY_PATTERN, "$1[redacted]");
}

function findSensitivePaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return redactEvidenceText(value) === value ? [] : [path || "/"];
  if (Array.isArray(value)) return value.flatMap((item, index) => findSensitivePaths(item, `${path}/${index}`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => findSensitivePaths(item, `${path}/${escapePointer(key)}`));
}

function redactValue(value: unknown, path: string, paths: string[]): unknown {
  if (typeof value === "string") {
    const redacted = redactEvidenceText(value);
    if (redacted !== value) paths.push(path || "/");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${path}/${index}`, paths));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactValue(item, `${path}/${escapePointer(key)}`, paths)
  ]));
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").reduce<unknown>((current, part) => {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (isRecord(current)) return current[key];
    return undefined;
  }, value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
