import { canTransition, makeDomainID, type AttentionStatus } from "../../xuanwu/coreDomainContracts.ts";
import { TERMINAL_SOURCE_RESOLUTIONS } from "./contracts.model.ts";
import type { AttentionCandidate, AttentionRecord } from "./contracts.model.ts";
import { ownerKey, strongestCorrelation, sourceIdentity, assertCandidate, compareAttention, mostSevere, uniqueSources, uniqueStrings, attentionPriority, uniqueDomainRefs } from "./contracts.validation.ts";

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

export function projectGroup(key: string, candidates: AttentionCandidate[]): AttentionRecord {
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

export function projectedStatus(candidates: AttentionCandidate[]): AttentionStatus {
  const refs = candidates.map((item) => item.source_ref);
  if (refs.every((ref) => TERMINAL_SOURCE_RESOLUTIONS.has(ref.resolution))) {
    return refs.every((ref) => ref.resolution === "dismissed") ? "dismissed" : "resolved";
  }
  const active = candidates.filter((item) => item.source_ref.resolution === "active").map((item) => item.status);
  if (active.includes("open")) return "open";
  if (active.includes("waiting")) return "waiting";
  return "acknowledged";
}

export function transitionStatus(from: AttentionStatus, to: AttentionStatus): AttentionStatus {
  if (from === to) return to;
  if (!canTransition("attention", from, to)) throw new Error(`invalid Attention transition ${from} -> ${to}`);
  return to;
}
