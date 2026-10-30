import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../../db/database.ts";
import { createIssueSupervisorEvent } from "../../db/repositories/pi.ts";
import { PI_SUPERVISOR_DECISION_JSON_SCHEMA, type PiSupervisorDecisionJson } from "./issueSupervisorRecovery.ts";
import { decisionFailure, decisionFailurePayload, schemaDecisionFailure, type DecisionFailure } from "./issueSupervisorDecisionFailure.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { type AppLanguage } from "../../i18n/language.ts";
import { cleanString } from "../../util/values.ts";

export function parseDecision(
  raw: string,
  context: IssueSupervisorRecoveryContext,
  now: Date
): { decision: PiSupervisorDecisionJson; valid: true } | DecisionFailure {
  const parsed = parseJsonObject(extractJson(raw));
  if (!parsed) return decisionFailure("invalid supervisor decision JSON");
  const normalized = normalizeDecisionObject(parsed);
  if (!Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, normalized)) {
    return schemaDecisionFailure(normalized);
  }
  const decision = normalized as PiSupervisorDecisionJson;
  const semanticError = semanticDecisionError(decision, context, now);
  return semanticError ? decisionFailure(semanticError) : { decision, valid: true };
}

export function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function normalizeDecisionObject(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  if (typeof normalized.confidence === "number" && Number.isFinite(normalized.confidence)) {
    const confidence = normalized.confidence > 1 ? normalized.confidence / 100 : normalized.confidence;
    normalized.confidence = confidence >= 0.75 ? "high" : confidence >= 0.4 ? "medium" : "low";
  }
  for (const key of ["recovery_message", "wait_until", "repair_diagnosis_code", "repair_operation"] as const) {
    if (normalized[key] === null) delete normalized[key];
  }
  const fallback = cleanString(normalized.fallback_if_no_progress);
  if (!["needs_user", "retry_issue", "blocked"].includes(fallback)) {
    normalized.fallback_if_no_progress = normalizeFallback(fallback);
  }
  return normalized;
}

export function normalizeFallback(value: string): "needs_user" | "retry_issue" | "blocked" {
  const text = value.toLowerCase();
  if (/(blocked?|stop|do not (?:repeat|retry|resume)|保持.*(?:阻塞|失败)|停止)/i.test(text)) return "blocked";
  if (/(needs?_user|human|user|manual|ask|escalat|人工|用户|求助)/i.test(text)) return "needs_user";
  if (/(retry|resume|recover|continue|重试|恢复|继续)/i.test(text)) return "retry_issue";
  return "blocked";
}

export function fallbackDecision(context: IssueSupervisorRecoveryContext, reason: string, language: AppLanguage): PiSupervisorDecisionJson {
  const chinese = language === "zh-CN";
  return {
    confidence: "low",
    decision: "noop",
    evidence_refs: ["supervisor_decision_invalid", ...candidateEvidence(context)],
    expected_outcome: chinese ? "Supervisor 在冷却后重试决策，且不修改 Issue 或 Run" : "Supervisor retries its decision after cooldown without mutating the Issue or Run",
    fallback_if_no_progress: "blocked",
    rationale: reason,
    recovery_message: chinese ? "玄武 Supervisor 返回了无效决策；保持当前状态不变，并在冷却后重试决策。" : "Xuanwu Supervisor returned an invalid decision; keep current state unchanged and retry the decision after cooldown.",
    risk_level: "medium"
  };
}

export function semanticDecisionError(
  decision: PiSupervisorDecisionJson,
  context: IssueSupervisorRecoveryContext,
  now: Date
): string {
  const decisionType = cleanString(decision.decision);
  if (futureRetryAfter(context, now) && !["wait", "needs_user", "blocked", "noop"].includes(decisionType)) {
    return "supervisor decision ignored a future provider retry-after window";
  }
  if ((decisionType === "resume_session" || decisionType === "steer_running_turn") &&
    cleanString(context.session.provider_session_id) === "") {
    return "session recovery decision requires an existing provider session; retry_issue is required for a fresh provider process";
  }
  if (decisionType === "repair_issue_state" && !matchingStateRepair(context, decision)) {
    return "repair_issue_state requires a current state_diagnostics recommended action";
  }
  if (decisionType === "wait" && cleanString(decision.wait_until) === "") {
    return "wait decision requires wait_until";
  }
  if ((decisionType === "resume_session" || decisionType === "steer_running_turn") &&
    cleanString(decision.recovery_message) === "") {
    return "session recovery decision requires recovery_message";
  }
  return "";
}

export function matchingStateRepair(
  context: IssueSupervisorRecoveryContext,
  decision: PiSupervisorDecisionJson
): boolean {
  const diagnosisCode = cleanString(decision.repair_diagnosis_code);
  const operation = cleanString(decision.repair_operation);
  if (diagnosisCode === "" || operation === "") return false;
  return (context.state_diagnostics ?? []).some((diagnostic) =>
    diagnostic.code === diagnosisCode &&
    diagnostic.recommended_actions.some((action) => action.operation === operation)
  );
}

export function recordDecisionSuccess(
  db: RunnerDatabase,
  context: IssueSupervisorRecoveryContext,
  decision: PiSupervisorDecisionJson
): void {
  createIssueSupervisorEvent(db, {
    confidence: decision.confidence,
    decision: decision.decision,
    diagnosis_code: primaryDiagnosis(context),
    event_type: "decision",
    issue_id: issueID(context),
    payload_json: { decision, valid: true },
    project_id: cleanString(context.project.id),
    provider: cleanString(context.session.provider) || cleanString(context.provider_error?.provider),
    provider_error_category: providerCategory(context),
    provider_session_id: cleanString(context.session.provider_session_id),
    provider_turn_id: cleanString(context.session.provider_turn_id),
    retry_after_at: cleanString(decision.wait_until) || cleanString(context.provider_error?.retry_after_at),
    run_id: cleanString(context.latest_run?.id)
  });
}

export function recordDecisionFailure(
  db: RunnerDatabase,
  context: IssueSupervisorRecoveryContext,
  raw: string,
  failure: DecisionFailure,
  fallback: PiSupervisorDecisionJson
): void {
  createIssueSupervisorEvent(db, {
    confidence: fallback.confidence,
    decision: fallback.decision,
    diagnosis_code: primaryDiagnosis(context),
    event_type: "decision_failed",
    issue_id: issueID(context),
    payload_json: decisionFailurePayload({ context, failure, fallback, raw }),
    project_id: cleanString(context.project.id),
    provider: cleanString(context.session.provider) || cleanString(context.provider_error?.provider),
    provider_error_category: providerCategory(context),
    provider_session_id: cleanString(context.session.provider_session_id),
    provider_turn_id: cleanString(context.session.provider_turn_id),
    retry_after_at: cleanString(context.provider_error?.retry_after_at),
    run_id: cleanString(context.latest_run?.id)
  });
}

export function issueID(context: IssueSupervisorRecoveryContext): number {
  const value = context.issue.id;
  return typeof value === "number" ? value : Number(value) || 0;
}

export function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.candidates[0]?.diagnosis_code) || cleanString(context.provider_error?.diagnosis_code);
}

export function providerCategory(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.provider_error?.category);
}

export function futureRetryAfter(context: IssueSupervisorRecoveryContext, now: Date): boolean {
  const retryAt = Date.parse(cleanString(context.provider_error?.retry_after_at));
  return Number.isFinite(retryAt) && retryAt > now.getTime();
}

export function candidateEvidence(context: IssueSupervisorRecoveryContext): string[] {
  return context.candidates.flatMap((candidate) => candidate.evidence_refs ?? []).slice(0, 5);
}
