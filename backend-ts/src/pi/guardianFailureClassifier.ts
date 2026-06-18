import type { ProviderErrorCategory } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import {
  classifyRecoveryDiagnosis,
  isTransientRecoveryDiagnosis,
  type RecoveryFailureClass
} from "./recoveryDiagnosis.ts";

export const GUARDIAN_SIGNAL_SEVERITIES = ["info", "watch", "actionable", "urgent"] as const;
export const GUARDIAN_FAILURE_CLASSES = ["none", "transient", "needs_context", "unsafe", "exhausted"] as const;

export type GuardianSignalSeverity = typeof GUARDIAN_SIGNAL_SEVERITIES[number];
export type GuardianFailureClass = RecoveryFailureClass;
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

const SEVERITY_RANK: Record<GuardianSignalSeverity, number> = {
  actionable: 2,
  info: 0,
  urgent: 3,
  watch: 1
};

export function classifyGuardianFailure(input: GuardianFailureClassifierInput): GuardianFailureClassification {
  const classified = classifyRecoveryDiagnosis({
    diagnosisCode: input.diagnosisCode,
    providerErrorCategory: input.providerErrorCategory,
    status: input.status
  });
  return {
    diagnosis_code: classified.diagnosis_code,
    evidence: classified.evidence,
    failure_class: classified.failure_class,
    reason: classified.reason,
    severity: classified.severity
  };
}

export function resolveDeterministicSeverity(
  deterministic: GuardianSignalSeverity,
  suggested?: string
): GuardianSignalSeverity {
  const candidate = severityValue(suggested) ?? deterministic;
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[deterministic] ? candidate : deterministic;
}

export function isTransientGuardianDiagnosis(value: string | PiSupervisorDiagnosisCode | undefined): boolean {
  return isTransientRecoveryDiagnosis(clean(value));
}

function severityValue(value: unknown): GuardianSignalSeverity | undefined {
  const text = clean(value).toLowerCase();
  return (GUARDIAN_SIGNAL_SEVERITIES as readonly string[]).includes(text) ? text as GuardianSignalSeverity : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
