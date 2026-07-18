import {
  ATTENTION_STATUSES,
  STATE_TRANSITIONS,
  canTransition,
  makeDomainID,
  parseDomainID,
  type AttentionID,
  type AttentionStatus,
  type DomainActor,
  type DomainRef,
  type ScopeOwner
} from "../../xuanwu/coreDomainContracts.ts";

export { ATTENTION_STATUSES, type AttentionID, type AttentionStatus };

// P00.04 remains the single source for the shared Attention status vocabulary and edge table.
export const ATTENTION_STATE_TRANSITIONS = STATE_TRANSITIONS.attention;

export const ATTENTION_TYPES = [
  "blocker",
  "failure",
  "approval_required",
  "input_required",
  "verification_required",
  "connection_issue"
] as const;
export type AttentionType = typeof ATTENTION_TYPES[number];

export const ATTENTION_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type AttentionPriority = typeof ATTENTION_PRIORITIES[number];

export const ATTENTION_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type AttentionSeverity = typeof ATTENTION_SEVERITIES[number];

export const ATTENTION_SOURCE_AUTHORITIES = [
  "attention_inbox_items",
  "pi_guardian_alerts",
  "pi_approval_requests",
  "pi_actions",
  "issues"
] as const;
export type AttentionSourceAuthority = typeof ATTENTION_SOURCE_AUTHORITIES[number];

export const ATTENTION_SOURCE_RESOLUTIONS = ["active", "resolved", "dismissed"] as const;
export type AttentionSourceResolution = typeof ATTENTION_SOURCE_RESOLUTIONS[number];

export const ATTENTION_PRIORITY_TABLE = {
  blocker: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
  failure: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
  approval_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  input_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  verification_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
  connection_issue: { critical: "p0", high: "p1", medium: "p1", low: "p2" }
} as const satisfies Record<AttentionType, Record<AttentionSeverity, AttentionPriority>>;

export const ATTENTION_ESCALATION_AFTER_MS = {
  p0: null,
  p1: 60 * 60 * 1000,
  p2: 4 * 60 * 60 * 1000,
  p3: 24 * 60 * 60 * 1000
} as const satisfies Record<AttentionPriority, number | null>;

export type AttentionSourceRef = {
  authority: AttentionSourceAuthority;
  correlation_refs: string[];
  local_id: string;
  resolution: AttentionSourceResolution;
  source_state: string;
};

export type AttentionCandidate = {
  created_at: string;
  evidence_refs?: string[];
  next_action: string;
  owner: ScopeOwner;
  reason_code: string;
  related_refs?: string[];
  required_actor: string;
  severity: AttentionSeverity;
  source_ref: AttentionSourceRef;
  status: AttentionStatus;
  subject_refs?: DomainRef[];
  summary: string;
  type: AttentionType;
  updated_at: string;
};

export type AttentionEscalation = {
  count: number;
  last_escalated_at?: string;
};

export type AttentionRecord = {
  created_at: string;
  dedupe_key: string;
  evidence_refs: string[];
  escalation: AttentionEscalation;
  id: AttentionID;
  next_action: string;
  owner: ScopeOwner;
  priority: AttentionPriority;
  reason_code: string;
  related_refs: string[];
  required_actor: string;
  revision: number;
  severity: AttentionSeverity;
  snoozed_until?: string;
  source_refs: AttentionSourceRef[];
  status: AttentionStatus;
  subject_refs: DomainRef[];
  summary: string;
  type: AttentionType;
  updated_at: string;
};

export type AttentionTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type AttentionTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: AttentionTransitionGate;
  occurred_at: string;
  reason: string;
};

export type AttentionCommand = {
  action: "acknowledge" | "snooze" | "resolve" | "dismiss" | "escalate";
  audit: AttentionTransitionAudit;
  expected_revision: number;
  snoozed_until?: string;
};

export type AttentionTransitionResult = {
  attention: AttentionRecord;
  audit_event: {
    actor: DomainActor;
    after_status: AttentionStatus;
    before_status: AttentionStatus;
    correlation_id: string;
    event_id: string;
    gate: AttentionTransitionGate;
    occurred_at: string;
    operation: AttentionCommand["action"] | "source_reconciled";
    reason: string;
    source_refs: string[];
  };
};

const PRIORITY_INDEX: Readonly<Record<AttentionPriority, number>> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const TERMINAL_ATTENTION_STATUSES = new Set<AttentionStatus>(["resolved", "dismissed"]);
const TERMINAL_SOURCE_RESOLUTIONS = new Set<AttentionSourceResolution>(["resolved", "dismissed"]);
const CORRELATION_STRENGTH = [
  "approval:", "run:", "run_group:", "connection:", "issue:", "work:", "conversation:"
] as const;

export function attentionPriority(
  type: AttentionType,
  severity: AttentionSeverity,
  escalationCount = 0
): AttentionPriority {
  const base = ATTENTION_PRIORITY_TABLE[type][severity];
  const level = Math.max(0, PRIORITY_INDEX[base] - nonNegativeInteger(escalationCount, "escalationCount"));
  return ATTENTION_PRIORITIES[level];
}

export function attentionDedupeKey(candidate: AttentionCandidate): string {
  const owner = ownerKey(candidate.owner);
  const correlation = strongestCorrelation(candidate.source_ref.correlation_refs);
  const identity = correlation || sourceIdentity(candidate.source_ref);
  return `${owner}|${candidate.type}|${identity}`;
}

export function consolidateAttentionCandidates(
  candidates: readonly AttentionCandidate[]
): AttentionRecord[] {
  const groups = new Map<string, AttentionCandidate[]>();
  for (const candidate of candidates) {
    assertCandidate(candidate);
    const key = attentionDedupeKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.entries()].map(([key, grouped]) => projectGroup(key, grouped))
    .sort(compareAttention);
}

export function applyAttentionCommand(
  current: AttentionRecord,
  command: AttentionCommand
): AttentionTransitionResult {
  assertAttentionRecord(current);
  assertAudit(command.audit);
  if (command.expected_revision !== current.revision) {
    throw new Error(`Attention revision conflict: expected ${command.expected_revision}, found ${current.revision}`);
  }
  if (command.audit.gate.decision !== "allow") {
    throw new Error(`Attention command requires an allow gate, found ${command.audit.gate.decision}`);
  }
  if (command.action === "escalate" && command.audit.gate.authority !== "deterministic_policy") {
    throw new Error("Attention escalation requires a deterministic policy gate");
  }
  if (TERMINAL_ATTENTION_STATUSES.has(current.status)) {
    throw new Error(`Attention ${current.id} is terminal`);
  }

  const next = structuredClone(current);
  const before = current.status;
  switch (command.action) {
    case "acknowledge":
      next.status = transitionStatus(current.status, "acknowledged");
      delete next.snoozed_until;
      break;
    case "snooze": {
      const until = requiredFutureTimestamp(command.snoozed_until, command.audit.occurred_at, "snoozed_until");
      next.status = transitionStatus(current.status, "waiting");
      next.snoozed_until = until;
      break;
    }
    case "resolve":
      next.status = transitionStatus(current.status, "resolved");
      delete next.snoozed_until;
      break;
    case "dismiss":
      next.status = transitionStatus(current.status, "dismissed");
      delete next.snoozed_until;
      break;
    case "escalate":
      next.escalation.count += 1;
      next.escalation.last_escalated_at = command.audit.occurred_at;
      next.priority = attentionPriority(next.type, next.severity, next.escalation.count);
      break;
  }
  next.revision += 1;
  next.updated_at = command.audit.occurred_at;
  return transitionResult(current, next, command.action, command.audit);
}

export function escalateAttentionIfDue(
  current: AttentionRecord,
  audit: AttentionTransitionAudit
): AttentionTransitionResult | null {
  if (!isAttentionEscalationDue(current, audit.occurred_at)) return null;
  return applyAttentionCommand(current, {
    action: "escalate",
    audit,
    expected_revision: current.revision
  });
}

export function isAttentionEscalationDue(current: AttentionRecord, now: string): boolean {
  assertAttentionRecord(current);
  const nowMs = timestampMs(now, "now");
  if (TERMINAL_ATTENTION_STATUSES.has(current.status) || current.priority === "p0") return false;
  if (current.snoozed_until && nowMs < timestampMs(current.snoozed_until, "snoozed_until")) return false;
  const delay = ATTENTION_ESCALATION_AFTER_MS[current.priority];
  if (delay === null) return false;
  const baseline = current.escalation.last_escalated_at ?? current.created_at;
  return nowMs - timestampMs(baseline, "escalation baseline") >= delay;
}

export function reconcileAttentionSources(
  current: AttentionRecord,
  sourceRefs: readonly AttentionSourceRef[],
  audit: AttentionTransitionAudit
): AttentionTransitionResult {
  assertAttentionRecord(current);
  assertAudit(audit);
  if (audit.gate.authority !== "deterministic_policy" || audit.gate.decision !== "allow") {
    throw new Error("Attention source reconciliation requires an allowed deterministic policy gate");
  }
  const updates = new Map(sourceRefs.map((ref) => [sourceIdentity(ref), normalizedSourceRef(ref)]));
  const next = structuredClone(current);
  next.source_refs = current.source_refs.map((ref) => updates.get(sourceIdentity(ref)) ?? ref);
  const unknown = [...updates.keys()].filter((key) => !current.source_refs.some((ref) => sourceIdentity(ref) === key));
  if (unknown.length > 0) throw new Error(`Attention source reconciliation contains unknown refs: ${unknown.join(", ")}`);

  const before = current.status;
  if (next.source_refs.every((ref) => TERMINAL_SOURCE_RESOLUTIONS.has(ref.resolution))) {
    const target = next.source_refs.every((ref) => ref.resolution === "dismissed") ? "dismissed" : "resolved";
    if (!TERMINAL_ATTENTION_STATUSES.has(next.status)) next.status = transitionStatus(next.status, target);
    delete next.snoozed_until;
  }
  next.revision += 1;
  next.updated_at = audit.occurred_at;
  return transitionResult({ ...current, status: before }, next, "source_reconciled", audit);
}

export function validateAttentionRecord(record: AttentionRecord): string[] {
  const errors: string[] = [];
  const parsed = parseDomainID(record.id);
  if (!parsed || parsed.kind !== "attention") errors.push("id must be an Attention domain id");
  if (!ATTENTION_TYPES.includes(record.type)) errors.push(`unsupported Attention type ${record.type}`);
  if (!ATTENTION_PRIORITIES.includes(record.priority)) errors.push(`unsupported Attention priority ${record.priority}`);
  if (!ATTENTION_SEVERITIES.includes(record.severity)) errors.push(`unsupported Attention severity ${record.severity}`);
  if (!ATTENTION_STATUSES.includes(record.status)) errors.push(`unsupported Attention status ${record.status}`);
  if (!record.dedupe_key.trim()) errors.push("dedupe_key is required");
  if (!record.summary.trim()) errors.push("summary is required");
  if (!record.reason_code.trim()) errors.push("reason_code is required");
  if (!record.required_actor.trim()) errors.push("required_actor is required");
  if (!record.next_action.trim()) errors.push("next_action is required");
  if (record.source_refs.length === 0) errors.push("at least one source_ref is required");
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) errors.push("revision must be non-negative");
  if (!Number.isSafeInteger(record.escalation.count) || record.escalation.count < 0) {
    errors.push("escalation.count must be non-negative");
  }
  if (record.priority !== attentionPriority(record.type, record.severity, record.escalation.count)) {
    errors.push("priority does not match the deterministic priority table");
  }
  if (record.snoozed_until && record.status !== "waiting") errors.push("snoozed Attention must be waiting");
  for (const ref of record.source_refs) {
    try { normalizedSourceRef(ref); } catch (error) { errors.push((error as Error).message); }
  }
  return errors;
}

function projectGroup(key: string, candidates: AttentionCandidate[]): AttentionRecord {
  const ordered = [...candidates].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || sourceIdentity(left.source_ref).localeCompare(sourceIdentity(right.source_ref)));
  const first = ordered[0];
  const severity = mostSevere(ordered.map((item) => item.severity));
  const status = projectedStatus(ordered);
  const sourceRefs = uniqueSources(ordered.map((item) => item.source_ref));
  const canonical = sourceRefs[0];
  return {
    created_at: first.created_at,
    dedupe_key: key,
    evidence_refs: uniqueStrings(ordered.flatMap((item) => item.evidence_refs ?? [])),
    escalation: { count: 0 },
    id: makeDomainID("attention", canonical.authority, canonical.local_id),
    next_action: first.next_action,
    owner: first.owner,
    priority: attentionPriority(first.type, severity),
    reason_code: first.reason_code,
    related_refs: uniqueStrings(ordered.flatMap((item) => item.related_refs ?? [])),
    required_actor: first.required_actor,
    revision: 0,
    severity,
    source_refs: sourceRefs,
    status,
    subject_refs: uniqueDomainRefs(ordered.flatMap((item) => item.subject_refs ?? [])),
    summary: first.summary,
    type: first.type,
    updated_at: ordered.map((item) => item.updated_at).sort().at(-1) ?? first.updated_at
  };
}

function projectedStatus(candidates: AttentionCandidate[]): AttentionStatus {
  const refs = candidates.map((item) => item.source_ref);
  if (refs.every((ref) => TERMINAL_SOURCE_RESOLUTIONS.has(ref.resolution))) {
    return refs.every((ref) => ref.resolution === "dismissed") ? "dismissed" : "resolved";
  }
  const active = candidates.filter((item) => item.source_ref.resolution === "active").map((item) => item.status);
  if (active.includes("open")) return "open";
  if (active.includes("waiting")) return "waiting";
  return "acknowledged";
}

function transitionStatus(from: AttentionStatus, to: AttentionStatus): AttentionStatus {
  if (from === to) return to;
  if (!canTransition("attention", from, to)) throw new Error(`invalid Attention transition ${from} -> ${to}`);
  return to;
}

function transitionResult(
  before: AttentionRecord,
  after: AttentionRecord,
  operation: AttentionTransitionResult["audit_event"]["operation"],
  audit: AttentionTransitionAudit
): AttentionTransitionResult {
  return {
    attention: after,
    audit_event: {
      actor: audit.actor,
      after_status: after.status,
      before_status: before.status,
      correlation_id: audit.correlation_id,
      event_id: audit.event_id,
      gate: audit.gate,
      occurred_at: audit.occurred_at,
      operation,
      reason: audit.reason,
      source_refs: after.source_refs.map(sourceIdentity)
    }
  };
}

function assertAttentionRecord(record: AttentionRecord): void {
  const errors = validateAttentionRecord(record);
  if (errors.length > 0) throw new Error(`invalid Attention record: ${errors.join("; ")}`);
}

function assertCandidate(candidate: AttentionCandidate): void {
  if (!ATTENTION_TYPES.includes(candidate.type)) throw new Error(`unsupported Attention type ${candidate.type}`);
  if (!ATTENTION_SEVERITIES.includes(candidate.severity)) throw new Error(`unsupported Attention severity ${candidate.severity}`);
  if (!ATTENTION_STATUSES.includes(candidate.status)) throw new Error(`unsupported Attention status ${candidate.status}`);
  if (!candidate.summary.trim()) throw new Error("Attention summary is required");
  if (!candidate.reason_code.trim()) throw new Error("Attention reason_code is required");
  if (!candidate.required_actor.trim()) throw new Error("Attention required_actor is required");
  if (!candidate.next_action.trim()) throw new Error("Attention next_action is required");
  timestampMs(candidate.created_at, "created_at");
  timestampMs(candidate.updated_at, "updated_at");
  normalizedSourceRef(candidate.source_ref);
}

function assertAudit(audit: AttentionTransitionAudit): void {
  if (!audit.event_id.trim()) throw new Error("Attention audit event_id is required");
  if (!audit.actor.id.trim()) throw new Error("Attention audit actor.id is required");
  if (!audit.reason.trim()) throw new Error("Attention audit reason is required");
  if (!audit.correlation_id.trim()) throw new Error("Attention audit correlation_id is required");
  if (!audit.gate.policy_ref.trim()) throw new Error("Attention audit policy_ref is required");
  timestampMs(audit.occurred_at, "Attention audit occurred_at");
}

function normalizedSourceRef(ref: AttentionSourceRef): AttentionSourceRef {
  if (!ATTENTION_SOURCE_AUTHORITIES.includes(ref.authority)) {
    throw new Error(`unsupported Attention source authority ${ref.authority}`);
  }
  if (!ref.local_id.trim()) throw new Error("Attention source local_id is required");
  if (!ref.source_state.trim()) throw new Error("Attention source_state is required");
  if (!ATTENTION_SOURCE_RESOLUTIONS.includes(ref.resolution)) {
    throw new Error(`unsupported Attention source resolution ${ref.resolution}`);
  }
  return { ...ref, correlation_refs: uniqueStrings(ref.correlation_refs) };
}

function strongestCorrelation(refs: readonly string[]): string {
  const values = uniqueStrings(refs);
  for (const prefix of CORRELATION_STRENGTH) {
    const match = values.filter((value) => value.startsWith(prefix)).sort()[0];
    if (match) return match;
  }
  return "";
}

function sourceIdentity(ref: Pick<AttentionSourceRef, "authority" | "local_id">): string {
  return `${ref.authority}:${ref.local_id.trim()}`;
}

function ownerKey(owner: ScopeOwner): string {
  return owner.kind === "project" ? `project:${owner.project_id.trim()}` : "control_plane:local";
}

function mostSevere(values: readonly AttentionSeverity[]): AttentionSeverity {
  return [...values].sort((left, right) => ATTENTION_SEVERITIES.indexOf(left) - ATTENTION_SEVERITIES.indexOf(right))[0];
}

function uniqueSources(refs: readonly AttentionSourceRef[]): AttentionSourceRef[] {
  const sources = new Map<string, AttentionSourceRef>();
  for (const ref of refs) sources.set(sourceIdentity(ref), normalizedSourceRef(ref));
  return [...sources.values()].sort((left, right) => sourceIdentity(left).localeCompare(sourceIdentity(right)));
}

function uniqueDomainRefs(refs: readonly DomainRef[]): DomainRef[] {
  const values = new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function compareAttention(left: AttentionRecord, right: AttentionRecord): number {
  return PRIORITY_INDEX[left.priority] - PRIORITY_INDEX[right.priority]
    || left.created_at.localeCompare(right.created_at)
    || left.dedupe_key.localeCompare(right.dedupe_key);
}

function requiredFutureTimestamp(value: string | undefined, after: string, name: string): string {
  const timestamp = value?.trim() ?? "";
  if (timestampMs(timestamp, name) <= timestampMs(after, "occurred_at")) {
    throw new Error(`${name} must be after occurred_at`);
  }
  return timestamp;
}

function timestampMs(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a timestamp`);
  return parsed;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
