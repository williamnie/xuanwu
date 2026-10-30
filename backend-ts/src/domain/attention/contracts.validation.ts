import { ATTENTION_STATUSES, parseDomainID, type DomainRef, type ScopeOwner } from "../../xuanwu/coreDomainContracts.ts";
import { ATTENTION_PRIORITY_TABLE, PRIORITY_INDEX, ATTENTION_PRIORITIES, ATTENTION_TYPES, ATTENTION_SEVERITIES, ATTENTION_SOURCE_AUTHORITIES, ATTENTION_SOURCE_RESOLUTIONS, CORRELATION_STRENGTH } from "./contracts.model.ts";
import type { AttentionType, AttentionSeverity, AttentionPriority, AttentionRecord, AttentionCandidate, AttentionTransitionAudit, AttentionSourceRef } from "./contracts.model.ts";

export function attentionPriority(
  type: AttentionType,
  severity: AttentionSeverity,
  escalationCount = 0
): AttentionPriority {
  const base = ATTENTION_PRIORITY_TABLE[type][severity];
  const level = Math.max(0, PRIORITY_INDEX[base] - nonNegativeInteger(escalationCount, "escalationCount"));
  return ATTENTION_PRIORITIES[level];
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

export function assertAttentionRecord(record: AttentionRecord): void {
  const errors = validateAttentionRecord(record);
  if (errors.length > 0) throw new Error(`invalid Attention record: ${errors.join("; ")}`);
}

export function assertCandidate(candidate: AttentionCandidate): void {
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

export function assertAudit(audit: AttentionTransitionAudit): void {
  if (!audit.event_id.trim()) throw new Error("Attention audit event_id is required");
  if (!audit.actor.id.trim()) throw new Error("Attention audit actor.id is required");
  if (!audit.reason.trim()) throw new Error("Attention audit reason is required");
  if (!audit.correlation_id.trim()) throw new Error("Attention audit correlation_id is required");
  if (!audit.gate.policy_ref.trim()) throw new Error("Attention audit policy_ref is required");
  timestampMs(audit.occurred_at, "Attention audit occurred_at");
}

export function normalizedSourceRef(ref: AttentionSourceRef): AttentionSourceRef {
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

export function strongestCorrelation(refs: readonly string[]): string {
  const values = uniqueStrings(refs);
  for (const prefix of CORRELATION_STRENGTH) {
    const match = values.filter((value) => value.startsWith(prefix)).sort()[0];
    if (match) return match;
  }
  return "";
}

export function sourceIdentity(ref: Pick<AttentionSourceRef, "authority" | "local_id">): string {
  return `${ref.authority}:${ref.local_id.trim()}`;
}

export function ownerKey(owner: ScopeOwner): string {
  return owner.kind === "project" ? `project:${owner.project_id.trim()}` : "control_plane:local";
}

export function mostSevere(values: readonly AttentionSeverity[]): AttentionSeverity {
  return [...values].sort((left, right) => ATTENTION_SEVERITIES.indexOf(left) - ATTENTION_SEVERITIES.indexOf(right))[0];
}

export function uniqueSources(refs: readonly AttentionSourceRef[]): AttentionSourceRef[] {
  const sources = new Map<string, AttentionSourceRef>();
  for (const ref of refs) sources.set(sourceIdentity(ref), normalizedSourceRef(ref));
  return [...sources.values()].sort((left, right) => sourceIdentity(left).localeCompare(sourceIdentity(right)));
}

export function uniqueDomainRefs(refs: readonly DomainRef[]): DomainRef[] {
  const values = new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function compareAttention(left: AttentionRecord, right: AttentionRecord): number {
  return PRIORITY_INDEX[left.priority] - PRIORITY_INDEX[right.priority]
    || left.created_at.localeCompare(right.created_at)
    || left.dedupe_key.localeCompare(right.dedupe_key);
}

export function requiredFutureTimestamp(value: string | undefined, after: string, name: string): string {
  const timestamp = value?.trim() ?? "";
  if (timestampMs(timestamp, name) <= timestampMs(after, "occurred_at")) {
    throw new Error(`${name} must be after occurred_at`);
  }
  return timestamp;
}

export function timestampMs(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a timestamp`);
  return parsed;
}

export function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
