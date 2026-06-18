export const RECOVERY_DIAGNOSIS_CODES = [
  "provider_eof",
  "stream_disconnect",
  "executor_stream_disconnected",
  "provider_timeout",
  "provider_rate_limited",
  "provider_retry_after_waiting",
  "provider_retry_after_ready",
  "provider_transient_network_error",
  "transport_restart",
  "scheduler_retryable_error",
  "session_no_recent_progress",
  "missing_user_input",
  "ambiguous_requirement",
  "auth_required",
  "approval_denied",
  "external_account_required",
  "business_decision_required",
  "build_broken_needs_decision",
  "requires_human_decision",
  "unsafe_or_external",
  "session_recovery_exhausted",
  "recovery_budget_exhausted"
] as const;

export const RECOVERY_FAILURE_CLASSES = [
  "none",
  "transient",
  "needs_context",
  "unsafe",
  "exhausted"
] as const;

export type RecoveryDiagnosisCode = typeof RECOVERY_DIAGNOSIS_CODES[number];
export type RecoveryDiagnosisSeverity = "info" | "watch" | "actionable" | "urgent";
export type RecoveryFailureClass = typeof RECOVERY_FAILURE_CLASSES[number];
export type RecoveryDiagnosisInput = {
  diagnosisCode?: string;
  providerErrorCategory?: string;
  status?: string;
};
export type RecoveryDiagnosisClassification = {
  diagnosis_code: string;
  evidence: string[];
  failure_class: RecoveryFailureClass;
  reason: string;
  severity: RecoveryDiagnosisSeverity;
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
  "session_no_recent_progress",
  "stream_disconnect",
  "transport_restart"
]);
const NEEDS_CONTEXT_DIAGNOSIS = new Set([
  "ambiguous_requirement",
  "approval_denied",
  "auth_required",
  "build_broken_needs_decision",
  "business_decision_required",
  "external_account_required",
  "missing_user_input",
  "requires_human_decision"
]);
const UNSAFE_DIAGNOSIS = new Set(["unsafe_or_external"]);
const EXHAUSTED_DIAGNOSIS = new Set([
  "budget_exhausted",
  "failed_retry_exhausted",
  "recovery_budget_exhausted",
  "recovery_exhausted",
  "session_recovery_exhausted"
]);
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["network", "rate_limit", "stream_disconnect"]);
const ACTIONABLE_PROVIDER_CATEGORIES = new Set(["auth", "business_failure", "permission", "quota"]);

export function classifyRecoveryDiagnosis(input: RecoveryDiagnosisInput): RecoveryDiagnosisClassification {
  const status = clean(input.status).toLowerCase();
  const diagnosis = clean(input.diagnosisCode).toLowerCase();
  const providerCategory = clean(input.providerErrorCategory).toLowerCase();
  if (UNSAFE_DIAGNOSIS.has(diagnosis)) return diagnosisClassification("unsafe", "urgent", diagnosis);
  if (EXHAUSTED_DIAGNOSIS.has(diagnosis)) return diagnosisClassification("exhausted", "actionable", diagnosis);
  if (NEEDS_CONTEXT_DIAGNOSIS.has(diagnosis)) return diagnosisClassification("needs_context", "actionable", diagnosis);
  if (ACTIONABLE_PROVIDER_CATEGORIES.has(providerCategory)) {
    return classification("needs_context", "actionable", diagnosis, `provider category ${providerCategory} requires user context`, ["provider_error_category"]);
  }
  if (TRANSIENT_DIAGNOSIS.has(diagnosis)) return diagnosisClassification("transient", "watch", diagnosis);
  if (diagnosis !== "") {
    return classification("needs_context", "actionable", diagnosis, `unknown deterministic diagnosis ${diagnosis} requires review`, ["diagnosis_code"]);
  }
  if (TRANSIENT_PROVIDER_CATEGORIES.has(providerCategory)) {
    return classification("transient", "watch", diagnosis, `provider category ${providerCategory} is transient`, ["provider_error_category"]);
  }
  if (status === "completed" || status === "done") {
    return classification("none", "info", diagnosis, "completed output is not a provider failure", ["status"]);
  }
  return classification("none", "info", diagnosis, "no deterministic provider failure diagnosis", []);
}

export function isTransientRecoveryDiagnosis(value: string | undefined): boolean {
  return TRANSIENT_DIAGNOSIS.has(clean(value).toLowerCase());
}

export function isAutomaticRecoveryBlockedDiagnosis(value: string | undefined): boolean {
  return ["needs_context", "unsafe", "exhausted"].includes(classifyRecoveryDiagnosis({
    diagnosisCode: value
  }).failure_class);
}

function diagnosisClassification(
  failureClass: RecoveryFailureClass,
  severity: RecoveryDiagnosisSeverity,
  diagnosis: string
): RecoveryDiagnosisClassification {
  return classification(failureClass, severity, diagnosis, `deterministic diagnosis ${diagnosis} is ${failureClass}`, ["diagnosis_code"]);
}

function classification(
  failureClass: RecoveryFailureClass,
  severity: RecoveryDiagnosisSeverity,
  diagnosis: string,
  reason: string,
  evidence: string[]
): RecoveryDiagnosisClassification {
  return { diagnosis_code: diagnosis, evidence, failure_class: failureClass, reason, severity };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
