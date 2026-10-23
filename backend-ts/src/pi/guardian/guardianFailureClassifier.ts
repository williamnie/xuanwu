import type { ProviderErrorCategory } from "../supervisor/providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "../supervisor/issueSupervisorRecovery.ts";
import {
  classifyRecoveryDiagnosis,
  type RecoveryFailureClass
} from "../supervisor/recoveryDiagnosis.ts";
import { cleanString } from "../../util/values.ts";

const GUARDIAN_SIGNAL_SEVERITIES = ["info", "watch", "actionable", "urgent"] as const;

export type GuardianSignalSeverity = typeof GUARDIAN_SIGNAL_SEVERITIES[number];
type GuardianFailureClass = RecoveryFailureClass;
type GuardianFailureClassifierInput = {
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

function severityValue(value: unknown): GuardianSignalSeverity | undefined {
  const text = cleanString(value).toLowerCase();
  return (GUARDIAN_SIGNAL_SEVERITIES as readonly string[]).includes(text) ? text as GuardianSignalSeverity : undefined;
}
