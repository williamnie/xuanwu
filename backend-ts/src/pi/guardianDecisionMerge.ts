import type { RunnerDatabase } from "../db/database.ts";
import type { PiGuardianDecision, PiGuardianEvent } from "../db/repositories/pi.ts";
import { guardianDecisionActionsJson } from "./guardianDecisionActionCandidates.ts";
import { classifyRecoveryDiagnosis } from "./recoveryDiagnosis.ts";

export const GUARDIAN_DECISION_TERMINAL_STATES = new Set(["completed", "failed", "skipped", "superseded"]);

export type GuardianDecisionSeverity = "info" | "watch" | "actionable" | "urgent";
export type GuardianDecisionCandidate = {
  action_type: string;
  actions_json: string;
  conversation_id: string;
  created_at: string;
  decision: string;
  decision_kind: string;
  diagnosis_code: string;
  event_id: string;
  event_type: string;
  issue_id: number;
  project_id: string;
  requires_user: number;
  risk_level: string;
  run_group_id: string;
  severity: GuardianDecisionSeverity;
  source_event_id: string;
  source_event_sequence_id: number;
};
export type GuardianDecisionPlan = {
  cooldown_until: string;
  id: string;
  idempotency_key: string;
  merge_key: string;
  window_ms: number;
};
export type GuardianDecisionMergeMeta = {
  base_key: string;
  event_count: number;
  event_ids: string[];
  idempotency_key: string;
  merge_key: string;
  severity: GuardianDecisionSeverity;
  source_event_sequence_id: number;
  window_ms: number;
};

const SEVERITY_RANK: Record<GuardianDecisionSeverity, number> = {
  actionable: 2,
  info: 0,
  urgent: 3,
  watch: 1
};
const INFO_MERGE_WINDOW_MS = 120_000;
const IMMEDIATE_WINDOW_MS = 0;
const WATCH_MERGE_WINDOW_MS = 30_000;

export function guardianDecisionCandidate(event: PiGuardianEvent, db?: RunnerDatabase): GuardianDecisionCandidate {
  const payload = jsonRecord(event.normalized_payload_json);
  const diagnosis = diagnosisCode(event, payload);
  const severity = deterministicSeverity(event, payload, diagnosis, severityValue(event.severity));
  const decisionKind = decisionKindForEvent(event, payload);
  return {
    action_type: clean(payload.action_type),
    actions_json: guardianDecisionActionsJson(event, payload, db),
    conversation_id: event.conversation_id,
    created_at: event.created_at,
    decision: decisionValue(decisionKind, severity),
    decision_kind: decisionKind,
    diagnosis_code: diagnosis,
    event_id: event.id,
    event_type: event.event_type,
    issue_id: event.issue_id,
    project_id: event.project_id,
    requires_user: requiresUser(decisionKind, severity),
    risk_level: riskLevel(severity),
    run_group_id: event.run_group_id,
    severity,
    source_event_id: event.source_event_id,
    source_event_sequence_id: event.sequence_id
  };
}

export function guardianDecisionPlan(
  candidate: GuardianDecisionCandidate,
  now: Date,
  forceImmediate = false
): GuardianDecisionPlan {
  const mergeKey = guardianDecisionMergeKey(candidate);
  const windowMs = decisionWindowMs(candidate, forceImmediate);
  const exact = sourceEventKey(candidate);
  const bucket = windowMs === 0 ? `event:${exact}` : `bucket:${bucketStart(candidate.created_at, windowMs)}`;
  return {
    cooldown_until: windowMs === 0 ? "" : iso(new Date(now.getTime() + windowMs)),
    id: `${mergeKey}:${bucket}`,
    idempotency_key: `${mergeKey}:${bucket}`,
    merge_key: mergeKey,
    window_ms: windowMs
  };
}

export function guardianDecisionMergeKey(candidate: GuardianDecisionCandidate): string {
  return `${guardianDecisionBaseKey(candidate)}:${candidate.severity}`;
}

export function guardianDecisionBaseKey(candidate: GuardianDecisionCandidate): string {
  return [
    candidate.decision_kind,
    clean(candidate.project_id) || "global",
    decisionScope(candidate),
    clean(candidate.action_type) || clean(candidate.diagnosis_code) || clean(candidate.event_type) || "general"
  ].join(":");
}

export function shouldBreakGuardianDecisionWindow(
  current: PiGuardianDecision,
  candidate: GuardianDecisionCandidate
): boolean {
  const meta = guardianDecisionMergeMeta(current);
  if (!meta) return false;
  if (!["actionable", "urgent"].includes(candidate.severity)) return false;
  return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[meta.severity];
}

export function mergeEvidenceJson(
  existing: PiGuardianDecision | null,
  candidate: GuardianDecisionCandidate,
  plan: GuardianDecisionPlan
): string {
  const previous = existing ? guardianDecisionMergeMeta(existing) : null;
  const ids = [...(previous?.event_ids ?? []), candidate.event_id].slice(-20);
  const meta: GuardianDecisionMergeMeta = {
    base_key: guardianDecisionBaseKey(candidate),
    event_count: (previous?.event_count ?? 0) + 1,
    event_ids: ids,
    idempotency_key: plan.idempotency_key,
    merge_key: plan.merge_key,
    severity: maxSeverity(previous?.severity, candidate.severity),
    source_event_sequence_id: Math.max(previous?.source_event_sequence_id ?? 0, candidate.source_event_sequence_id),
    window_ms: plan.window_ms
  };
  const preserved = existing
    ? jsonArray(existing.evidence_json).filter((item) => !Object.hasOwn(item, "guardian_decision_merge"))
    : [];
  return JSON.stringify([...preserved, { guardian_decision_merge: meta }]);
}

export function guardianDecisionMergeMeta(decision: PiGuardianDecision): GuardianDecisionMergeMeta | null {
  const evidence = jsonArray(decision.evidence_json);
  for (const item of evidence) {
    const meta = jsonRecord(item.guardian_decision_merge);
    if (clean(meta.merge_key) === "") continue;
    return {
      event_count: positiveInt(meta.event_count) || 0,
      event_ids: stringArray(meta.event_ids),
      base_key: clean(meta.base_key) || baseKeyFromMergeKey(meta.merge_key),
      idempotency_key: clean(meta.idempotency_key),
      merge_key: clean(meta.merge_key),
      severity: severityValue(meta.severity),
      source_event_sequence_id: positiveInt(meta.source_event_sequence_id) || 0,
      window_ms: positiveInt(meta.window_ms) || 0
    };
  }
  return null;
}

export function isActiveGuardianDecision(decision: PiGuardianDecision): boolean {
  return !GUARDIAN_DECISION_TERMINAL_STATES.has(decision.state);
}

function decisionWindowMs(candidate: GuardianDecisionCandidate, forceImmediate: boolean): number {
  if (forceImmediate || candidate.decision_kind === "approval" || candidate.severity === "urgent") return IMMEDIATE_WINDOW_MS;
  return candidate.severity === "info" ? INFO_MERGE_WINDOW_MS : WATCH_MERGE_WINDOW_MS;
}

function decisionKindForEvent(event: PiGuardianEvent, payload: Record<string, unknown>): string {
  const type = clean(event.event_type).toLowerCase();
  if (type.includes("approval") || clean(payload.approval_id) !== "") return "approval";
  if (type.includes("notification") || type.startsWith("issue.")) return "notification";
  return "recovery";
}

function decisionValue(kind: string, severity: GuardianDecisionSeverity): string {
  if (kind === "approval" || ["actionable", "urgent"].includes(severity)) return "needs_user";
  return "aggregate";
}

function diagnosisCode(event: PiGuardianEvent, payload: Record<string, unknown>): string {
  const classification = jsonRecord(payload.classification);
  return clean(payload.diagnosis_code) || clean(classification.diagnosis_code) ||
    clean(payload.kind) || clean(payload.signal_type) || clean(event.event_type);
}

function deterministicSeverity(
  event: PiGuardianEvent,
  payload: Record<string, unknown>,
  diagnosis: string,
  fallback: GuardianDecisionSeverity
): GuardianDecisionSeverity {
  if (!classifiesRecoveryDiagnosis(event, payload)) return fallback;
  const deterministic = classifyRecoveryDiagnosis({
    diagnosisCode: diagnosis,
    providerErrorCategory: clean(payload.provider_error_category),
    status: clean(payload.status)
  });
  return maxSeverity(fallback, deterministic.severity);
}

function classifiesRecoveryDiagnosis(event: PiGuardianEvent, payload: Record<string, unknown>): boolean {
  return clean(event.event_type) === "guardian.supervisor.candidate" ||
    clean(payload.signal_type) === "supervisor.candidate" ||
    clean(payload.provider_error_category) !== "";
}

function decisionScope(candidate: GuardianDecisionCandidate): string {
  if (candidate.issue_id > 0) return `issue:${candidate.issue_id}`;
  if (clean(candidate.run_group_id) !== "") return `group:${clean(candidate.run_group_id)}`;
  return `conversation:${clean(candidate.conversation_id) || "global"}`;
}

function sourceEventKey(candidate: GuardianDecisionCandidate): string {
  const sourceEventID = clean(candidate.source_event_id);
  if (sourceEventID !== "") return sourceEventID;
  return candidate.source_event_sequence_id > 0 ? String(candidate.source_event_sequence_id) : candidate.event_id;
}

function bucketStart(timestamp: string, windowMs: number): string {
  const parsed = Date.parse(timestamp);
  const time = Number.isFinite(parsed) ? parsed : Date.now();
  return iso(new Date(Math.floor(time / windowMs) * windowMs));
}

function maxSeverity(left: GuardianDecisionSeverity | undefined, right: GuardianDecisionSeverity): GuardianDecisionSeverity {
  return left && SEVERITY_RANK[left] > SEVERITY_RANK[right] ? left : right;
}

function requiresUser(kind: string, severity: GuardianDecisionSeverity): number {
  return kind === "approval" || ["actionable", "urgent"].includes(severity) ? 1 : 0;
}

function riskLevel(severity: GuardianDecisionSeverity): string {
  if (severity === "urgent") return "high";
  if (severity === "actionable") return "medium";
  return "low";
}

function severityValue(value: unknown): GuardianDecisionSeverity {
  const text = clean(value).toLowerCase();
  return text in SEVERITY_RANK ? text as GuardianDecisionSeverity : "info";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(jsonRecord) : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function baseKeyFromMergeKey(value: unknown): string {
  const parts = clean(value).split(":");
  return parts.length > 1 ? parts.slice(0, -1).join(":") : "";
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
