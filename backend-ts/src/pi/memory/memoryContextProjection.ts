import type { PiMemoryItem } from "../../db/repositories/pi.ts";
import { memoryWriteIdentity } from "../../db/repositories/pi/memoryHistory.ts";
import { parseMemoryExperience } from "./memoryExperience.ts";
import { technicalMemory } from "./memoryRetrieval.ts";
import { type PiMemoryContextItem, PiMemoryProvenance } from "./memoryContext.ts";
import { scopeKey, itemTokenEstimate } from "./memoryContextBudget.ts";

export function contextItem(item: PiMemoryItem): PiMemoryContextItem {
  const reference = memoryReference(item);
  const context: PiMemoryContextItem = {
    authority: item.authority,
    authorized_at: item.authorized_at,
    authorized_by: item.authorized_by,
    confidence: item.confidence,
    content: item.content,
    citation_id: item.citation_id,
    citation_label: item.citation_label,
    citation_type: item.citation_type,
    citation_url: item.citation_url,
    id: item.id,
    kind: item.kind,
    layer: item.layer,
    last_seen_at: item.last_seen_at,
    memory_key: item.memory_key,
    memory_type: item.memory_type,
    occurrence_count: item.occurrence_count,
    pinned: item.pinned,
    provenance: memoryProvenance(item, reference),
    reference,
    retrieval_scope: scopeKey({ scope: item.scope, scopeId: item.scope_id }),
    selection_reason: selectionReason(item),
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: item.source_id,
    source_path: reference,
    source_type: item.source_type,
    token_estimate: 0,
    truncated: false,
    updated_at: item.updated_at,
    revision: item.revision,
    content_fingerprint: memoryWriteIdentity(item).content,
    version: parseMemoryExperience(item.content)?.version || "",
    selection_stage: technicalMemory(item) ? "text_candidate" : "policy"
  };
  context.token_estimate = itemTokenEstimate(context);
  return context;
}

export function memoryProvenance(item: PiMemoryItem, reference: string): PiMemoryProvenance {
  return {
    citation_id: item.citation_id,
    citation_label: item.citation_label,
    citation_type: item.citation_type,
    citation_url: item.citation_url,
    reference,
    source_id: item.source_id,
    source_path: reference,
    source_type: item.source_type
  };
}

export function selectionReason(item: PiMemoryItem): string {
  const base = `scope ${scopeKey({ scope: item.scope, scopeId: item.scope_id })} matched retrieval request`;
  return item.pinned === 1 ? `${base}; pinned memory ranked first` : `${base}; ranked by scope and freshness`;
}

export function formatMemoryLine(item: PiMemoryContextItem): string {
  return `- [${item.reference} | revision=${item.revision} | fingerprint=${item.content_fingerprint} | memory_key=${item.memory_key} | authority=${item.authority} | seen=${item.occurrence_count} | ${item.scope}:${item.scope_id || "runner"} | ${sourceLabel(item)} | ${citationLabel(item)} | updated=${item.updated_at} | confidence=${item.confidence}${item.truncated ? " | truncated=true" : ""}] ${item.kind}: ${item.content}`;
}

export function sourceLabel(item: PiMemoryContextItem): string {
  const source = [item.source_type, item.source_id].filter(Boolean).join(":");
  return `source=${source || "unknown"}`;
}

export function citationLabel(item: PiMemoryContextItem): string {
  const ref = [item.citation_type, item.citation_id].filter(Boolean).join(":");
  const label = item.citation_label || item.citation_url;
  return `citation=${[ref, label].filter(Boolean).join(" ") || "none"}`;
}

export function memoryReference(item: PiMemoryItem): string {
  return `pi_memory_items/${item.id}`;
}
