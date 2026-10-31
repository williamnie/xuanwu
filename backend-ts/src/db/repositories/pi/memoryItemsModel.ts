import { cleanString, hasPatchValue, integerInput, integerValue, optionalString, requiredString } from "./common.ts";
import {
  type PiMemoryItemInput,
  type PiMemoryItem,
  type PiMemoryType,
  type PiMemoryLayer,
  type PiMemoryAuthority
} from "./memoryItems.ts";

export const PI_MEMORY_TYPES = ["user", "project", "inbox", "source", "skill"] as const;

export const PI_MEMORY_LAYERS = ["ephemeral", "working", "long_term"] as const;

export const PI_MEMORY_AUTHORITIES = ["advisory", "user_explicit", "evidence_backed"] as const;

export function normalizeCreate(input: PiMemoryItemInput): PiMemoryItem {
  const scope = cleanString(input.scope);
  return {
    id: cleanString(input.id), scope, scope_id: cleanString(input.scope_id),
    kind: cleanString(input.kind), content: cleanString(input.content),
    source_type: cleanString(input.source_type), source_id: cleanString(input.source_id),
    confidence: cleanString(input.confidence) || "medium",
    pinned: integerInput(input.pinned), disabled: integerInput(input.disabled),
    memory_type: normalizeMemoryType(input.memory_type, memoryTypeForScope(scope)),
    layer: normalizeMemoryLayer(input.layer),
    citation_type: cleanString(input.citation_type),
    citation_id: cleanString(input.citation_id),
    citation_label: cleanString(input.citation_label),
    citation_url: cleanString(input.citation_url),
    authority: normalizeMemoryAuthority(input.authority),
    authorized_by: cleanString(input.authorized_by),
    authorized_at: cleanString(input.authorized_at),
    memory_key: cleanString(input.memory_key) || cleanString(input.id),
    occurrence_count: positiveInteger(input.occurrence_count, 1),
    last_seen_at: cleanString(input.last_seen_at),
    revision: 1, created_at: "", updated_at: ""
  };
}

export function normalizeUpdate(input: PiMemoryItemInput): PiMemoryItemInput {
  const output = { ...input };
  if (hasPatchValue(input, "memory_type")) output.memory_type = normalizeMemoryType(input.memory_type, "user");
  if (hasPatchValue(input, "layer")) output.layer = normalizeMemoryLayer(input.layer);
  for (const field of ["citation_type", "citation_id", "citation_label", "citation_url"] as const) {
    if (hasPatchValue(input, field)) output[field] = cleanString(input[field]);
  }
  if (hasPatchValue(input, "authority")) output.authority = normalizeMemoryAuthority(input.authority);
  if (hasPatchValue(input, "authorized_by")) output.authorized_by = cleanString(input.authorized_by);
  if (hasPatchValue(input, "authorized_at")) output.authorized_at = cleanString(input.authorized_at);
  if (hasPatchValue(input, "memory_key")) output.memory_key = cleanString(input.memory_key);
  if (hasPatchValue(input, "occurrence_count")) output.occurrence_count = positiveInteger(input.occurrence_count, 1);
  if (hasPatchValue(input, "last_seen_at")) output.last_seen_at = cleanString(input.last_seen_at);
  return output;
}

export function mapPiMemoryItem(row: Record<string, unknown>): PiMemoryItem {
  const id = requiredString(row.id, "pi_memory_items.id");
  const updatedAt = requiredString(row.updated_at, "pi_memory_items.updated_at");
  return {
    id,
    scope: requiredString(row.scope, "pi_memory_items.scope"),
    scope_id: optionalString(row.scope_id), kind: requiredString(row.kind, "pi_memory_items.kind"),
    content: requiredString(row.content, "pi_memory_items.content"),
    source_type: optionalString(row.source_type), source_id: optionalString(row.source_id),
    confidence: requiredString(row.confidence, "pi_memory_items.confidence"),
    pinned: integerValue(row.pinned, "pi_memory_items.pinned"),
    disabled: integerValue(row.disabled, "pi_memory_items.disabled"),
    memory_type: normalizeMemoryType(row.memory_type, "user"),
    layer: normalizeMemoryLayer(row.layer),
    citation_type: optionalString(row.citation_type),
    citation_id: optionalString(row.citation_id),
    citation_label: optionalString(row.citation_label),
    citation_url: optionalString(row.citation_url),
    authority: normalizeMemoryAuthority(row.authority),
    authorized_by: optionalString(row.authorized_by),
    authorized_at: optionalString(row.authorized_at),
    memory_key: optionalString(row.memory_key) || id,
    occurrence_count: integerValue(row.occurrence_count, "pi_memory_items.occurrence_count"),
    last_seen_at: optionalString(row.last_seen_at) || updatedAt,
    revision: integerValue(row.revision, "pi_memory_items.revision"),
    created_at: requiredString(row.created_at, "pi_memory_items.created_at"),
    updated_at: updatedAt
  };
}

function normalizeMemoryType(value: unknown, fallback: PiMemoryType): PiMemoryType {
  const text = cleanString(value);
  if (text === "") return fallback;
  if (isMemoryType(text)) return text;
  throw new Error(`memory_type must be one of ${PI_MEMORY_TYPES.join(", ")}`);
}

function normalizeMemoryLayer(value: unknown): PiMemoryLayer {
  const text = cleanString(value);
  if (text === "") return "working";
  if (isMemoryLayer(text)) return text;
  throw new Error(`layer must be one of ${PI_MEMORY_LAYERS.join(", ")}`);
}

function normalizeMemoryAuthority(value: unknown): PiMemoryAuthority {
  const text = cleanString(value);
  if (text === "") return "advisory";
  if ((PI_MEMORY_AUTHORITIES as readonly string[]).includes(text)) return text as PiMemoryAuthority;
  throw new Error(`authority must be one of ${PI_MEMORY_AUTHORITIES.join(", ")}`);
}

function isMemoryType(value: string): value is PiMemoryType {
  return (PI_MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryLayer(value: string): value is PiMemoryLayer {
  return (PI_MEMORY_LAYERS as readonly string[]).includes(value);
}

function memoryTypeForScope(scope: string): PiMemoryType {
  if (scope === "project") return "project";
  if (scope === "inbox") return "inbox";
  if (scope === "source") return "source";
  if (scope === "skill") return "skill";
  return "user";
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
