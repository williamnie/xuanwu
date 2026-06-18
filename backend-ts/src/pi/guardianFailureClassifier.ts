import type { ProviderErrorCategory } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";

export const GUARDIAN_SIGNAL_SEVERITIES = ["info", "watch", "actionable", "urgent"] as const;
export const GUARDIAN_FAILURE_CLASSES = ["none", "transient", "needs_context", "unsafe"] as const;

export type GuardianSignalSeverity = typeof GUARDIAN_SIGNAL_SEVERITIES[number];
export type GuardianFailureClass = typeof GUARDIAN_FAILURE_CLASSES[number];
export type GuardianFailureClassifierInput = {
  diagnosisCode?: string;
  message?: string;
  providerErrorCategory?: ProviderErrorCategory | string;
  status?: string;
};
export type GuardianFailureClassification = {
  diagnosis_code: string;
  evidence: string[];
  failure_class: GuardianFailureClass;
  reason: string;
  severity: GuardianSignalSeverity;
};

const TRANSIENT_DIAGNOSIS = new Set([
  "executor_stream_disconnected",
  "provider_eof",
  "provider_rate_limited",
  "provider_retry_after_ready",
  "provider_retry_after_waiting",
  "provider_timeout",
  "provider_transient_network_error",
  "scheduler_retryable_error",
  "stream_disconnect",
  "transport_restart"
]);
const ACTIONABLE_DIAGNOSIS = new Set([
  "ambiguous_requirement",
  "approval_denied",
  "auth_required",
  "business_decision_required",
  "external_account_required",
  "missing_user_input",
  "requires_human_decision",
  "session_recovery_exhausted"
]);
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["network", "rate_limit", "stream_disconnect"]);
const ACTIONABLE_PROVIDER_CATEGORIES = new Set(["auth", "business_failure", "permission", "quota"]);
const SEVERITY_RANK: Record<GuardianSignalSeverity, number> = {
  actionable: 2,
  info: 0,
  urgent: 3,
  watch: 1
};

export function classifyGuardianFailure(input: GuardianFailureClassifierInput): GuardianFailureClassification {
  const status = clean(input.status).toLowerCase();
  const diagnosis = clean(input.diagnosisCode).toLowerCase();
  const providerCategory = clean(input.providerErrorCategory).toLowerCase();
  const message = clean(input.message).toLowerCase();
  if (status === "completed" || status === "done") return classification("none", "info", diagnosis, "completed output is not a provider failure", ["status"]);
  if (ACTIONABLE_DIAGNOSIS.has(diagnosis)) return classification("needs_context", "actionable", diagnosis, `deterministic diagnosis ${diagnosis} requires user context`, ["diagnosis_code"]);
  if (ACTIONABLE_PROVIDER_CATEGORIES.has(providerCategory)) return classification("needs_context", "actionable", diagnosis, `provider category ${providerCategory} requires user context`, ["provider_error_category"]);
  if (TRANSIENT_DIAGNOSIS.has(diagnosis)) return classification("transient", "watch", diagnosis, `deterministic diagnosis ${diagnosis} is transient`, ["diagnosis_code"]);
  if (TRANSIENT_PROVIDER_CATEGORIES.has(providerCategory)) return classification("transient", "watch", diagnosis, `provider category ${providerCategory} is transient`, ["provider_error_category"]);
  if (transientText(message)) return classification("transient", "watch", diagnosis, "message matches transient provider failure", ["message"]);
  if (actionableText(message)) return classification("needs_context", "actionable", diagnosis, "message matches context or business decision failure", ["message"]);
  if (diagnosis !== "") return classification("needs_context", "actionable", diagnosis, `unknown deterministic diagnosis ${diagnosis} requires review`, ["diagnosis_code"]);
  return classification("none", "info", diagnosis, "no provider failure signal", []);
}

export function resolveDeterministicSeverity(
  deterministic: GuardianSignalSeverity,
  suggested?: string
): GuardianSignalSeverity {
  const candidate = severityValue(suggested) ?? deterministic;
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[deterministic] ? candidate : deterministic;
}

export function isTransientGuardianDiagnosis(value: string | PiSupervisorDiagnosisCode | undefined): boolean {
  return TRANSIENT_DIAGNOSIS.has(clean(value).toLowerCase());
}

function classification(
  failureClass: GuardianFailureClass,
  severity: GuardianSignalSeverity,
  diagnosis: string,
  reason: string,
  evidence: string[]
): GuardianFailureClassification {
  return { diagnosis_code: diagnosis, evidence, failure_class: failureClass, reason, severity };
}

function severityValue(value: unknown): GuardianSignalSeverity | undefined {
  const text = clean(value).toLowerCase();
  return (GUARDIAN_SIGNAL_SEVERITIES as readonly string[]).includes(text) ? text as GuardianSignalSeverity : undefined;
}

function transientText(value: string): boolean {
  return /unexpected eof|\beof\b|stream disconnected|timeout|timed out|rate limit|too many requests|network error|connection reset|econnreset|socket hang up/.test(value);
}

function actionableText(value: string): boolean {
  return /missing (?:input|context)|ambiguous|business decision|auth(?:entication)? required|unauthorized|permission denied|approval denied|external account|validation failed|tests? failed|command failed|exit status/.test(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
