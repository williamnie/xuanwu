import { createHash } from "node:crypto";

export type ContextSourceType = "issue" | "session" | "memory" | "runtime" | "external_event";
export type RawEvidencePolicy = "hash_only" | "preserve_raw";

export type ContextSource = {
  hash: string;
  priority: number;
  raw_evidence_policy: RawEvidencePolicy;
  source_id: string;
  source_type: ContextSourceType;
  summary: string;
  token_budget_hint: number;
};
export type ContextSourceInput = Partial<Omit<ContextSource, "source_id" | "source_type">> & {
  raw_evidence?: unknown;
  source_id: string;
  source_type: ContextSourceType;
};
export type ContextPackTrace = {
  hash: string;
  kind: "context_pack_trace";
  sources: ContextSource[];
  token_budget_hint: number;
  trace_id: string;
  version: 0;
};

const SOURCE_TYPE_RANK: ContextSourceType[] = ["issue", "session", "memory", "runtime", "external_event"];
export const CONTEXT_PACK_TRACE_VERSION = 0;

type InternalSource = ContextSource & { raw_evidence_hash: string };

export function buildContextPackTrace(input: ContextSourceInput[]): ContextPackTrace {
  const sources = normalizeContextSources(input);
  const hash = hashValue({
    kind: "context_pack_trace",
    sources,
    version: CONTEXT_PACK_TRACE_VERSION
  });
  return {
    hash,
    kind: "context_pack_trace",
    sources,
    token_budget_hint: sources.reduce((sum, source) => sum + source.token_budget_hint, 0),
    trace_id: `context_pack_trace_v0_${hash.slice("sha256:".length, "sha256:".length + 16)}`,
    version: CONTEXT_PACK_TRACE_VERSION
  };
}

export function normalizeContextSources(input: ContextSourceInput[]): ContextSource[] {
  const groups = new Map<string, InternalSource[]>();
  for (const source of input.map(normalizeSourceInput)) {
    const key = sourceKey(source);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  return [...groups.values()].map(mergeSourceGroup).sort(compareSources);
}

function normalizeSourceInput(input: ContextSourceInput): InternalSource {
  const source = {
    priority: positiveInteger(input.priority),
    raw_evidence_policy: normalizeRawEvidencePolicy(input.raw_evidence_policy),
    source_id: requiredText(input.source_id, "source_id"),
    source_type: normalizeSourceType(input.source_type),
    summary: cleanText(input.summary),
    token_budget_hint: positiveInteger(input.token_budget_hint)
  };
  const raw_evidence_hash = input.raw_evidence === undefined ? "" : hashValue(input.raw_evidence);
  return {
    ...source,
    hash: cleanHash(input.hash) || hashValue({ ...source, raw_evidence_hash }),
    raw_evidence_hash
  };
}

function mergeSourceGroup(group: InternalSource[]): ContextSource {
  if (group.length === 1) return publicSource(group[0]);
  const seed = group[0];
  const merged = {
    priority: Math.max(...group.map((source) => source.priority)),
    raw_evidence_policy: group.some((source) => source.raw_evidence_policy === "preserve_raw") ? "preserve_raw" : "hash_only",
    source_id: seed.source_id,
    source_type: seed.source_type,
    summary: mergedSummary(group),
    token_budget_hint: Math.max(...group.map((source) => source.token_budget_hint))
  } satisfies Omit<ContextSource, "hash">;
  return {
    ...merged,
    hash: hashValue({ ...merged, members: group.map(memberFingerprint).sort(compareFingerprint) })
  };
}

function mergedSummary(group: InternalSource[]): string {
  return uniqueSorted(group.map((source) => source.summary).filter(Boolean)).join(" | ");
}

function memberFingerprint(source: InternalSource): Record<string, unknown> {
  return {
    hash: source.hash,
    priority: source.priority,
    raw_evidence_hash: source.raw_evidence_hash,
    raw_evidence_policy: source.raw_evidence_policy,
    summary: source.summary,
    token_budget_hint: source.token_budget_hint
  };
}

function compareFingerprint(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return stableJson(left).localeCompare(stableJson(right));
}

function publicSource(source: InternalSource): ContextSource {
  return {
    hash: source.hash,
    priority: source.priority,
    raw_evidence_policy: source.raw_evidence_policy,
    source_id: source.source_id,
    source_type: source.source_type,
    summary: source.summary,
    token_budget_hint: source.token_budget_hint
  };
}

function compareSources(left: ContextSource, right: ContextSource): number {
  return right.priority - left.priority ||
    sourceTypeRank(left.source_type) - sourceTypeRank(right.source_type) ||
    left.source_id.localeCompare(right.source_id) ||
    left.hash.localeCompare(right.hash);
}

function sourceKey(source: ContextSource): string {
  return `${source.source_type}:${source.source_id}`;
}

function sourceTypeRank(sourceType: ContextSourceType): number {
  return SOURCE_TYPE_RANK.indexOf(sourceType);
}

function normalizeSourceType(value: unknown): ContextSourceType {
  if (SOURCE_TYPE_RANK.includes(value as ContextSourceType)) return value as ContextSourceType;
  throw new Error("source_type is required");
}

function normalizeRawEvidencePolicy(value: unknown): RawEvidencePolicy {
  return value === "preserve_raw" ? "preserve_raw" : "hash_only";
}

function cleanHash(value: unknown): string {
  const text = cleanText(value);
  return /^sha256:[0-9a-f]{64}$/.test(text) ? text : "";
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function requiredText(value: unknown, name: string): string {
  const text = cleanText(value);
  if (text === "") throw new Error(`${name} is required`);
  return text;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
