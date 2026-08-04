import type { ProviderExecutionRef, ProviderId } from "../types.ts";
import { RAW_REF_ENVELOPE_MAX, SESSION_TRANSCRIPT_MAX_ITEMS, TRANSCRIPT_ITEM_PAYLOAD_MAX, type TranscriptItem, type TranscriptItemKind } from "./session.ts";

/**
 * P3：transcript normalization（设计 §3.3 provider-neutral 校验层）。
 * Core 只做 provider-neutral 处理：unknown item preserve（可展示、不改变状态）、
 * payload 有界裁剪（留 provenance）、terminal invariant 由上层保证。
 */

/** P3：adapter 产出的 transcript candidate（已脱敏/裁剪到 bounds 内）。 */
export type TranscriptItemCandidate = {
  id?: string;
  kind: TranscriptItemKind | string; // adapter 可能产出未知 kind
  role?: "user" | "assistant" | "system";
  text?: string;
  payload?: unknown;
  refs?: Partial<ProviderExecutionRef>;
  createdAt?: string;
};

const KNOWN_KINDS: ReadonlySet<string> = new Set(["message", "tool", "approval", "error", "unknown"]);

/**
 * P3：normalizeTranscriptItem——未知 kind 保留为 `unknown`（可展示、不改变状态），
 * 绝不抛错；payload 超过 bound 时裁剪并记录 provenance。
 */
export function normalizeTranscriptItem(candidate: TranscriptItemCandidate, providerId: ProviderId, index: number): TranscriptItem {
  const kind: TranscriptItemKind = KNOWN_KINDS.has(candidate.kind) ? (candidate.kind as TranscriptItemKind) : "unknown";
  let payload = candidate.payload;
  let size = approximateSize(payload);
  const bounded = size <= TRANSCRIPT_ITEM_PAYLOAD_MAX;
  if (!bounded) {
    payload = { truncated: true, note: "payload exceeded bound and was clipped" };
    size = approximateSize(payload);
  }
  const item: TranscriptItem = {
    id: candidate.id && candidate.id !== "" ? candidate.id : `${providerId}:item:${index}`,
    kind,
    ...(candidate.role ? { role: candidate.role } : {}),
    ...(candidate.text ? { text: candidate.text } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(candidate.refs ? { refs: candidate.refs } : {}),
    ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
    providerNative: {
      type: String(candidate.kind),
      version: 1,
      size
    }
  };
  return item;
}

/**
 * P3：transcript envelope——versioned bounded（设计 §4.2 AgentSessionRawRefV2 同类）。
 * 超限 item 由 normalizeTranscriptItem 已裁剪；这里做整体 item 数 bound + truncated 标记。
 */
export type TranscriptEnvelope = {
  version: 2;
  items: TranscriptItem[];
  provenance: { updatedAt: string; revision: number };
  truncated: boolean;
  size: number;
};

export function transcriptEnvelope(items: TranscriptItem[], revision: number, updatedAt: string): TranscriptEnvelope {
  const truncated = items.length > SESSION_TRANSCRIPT_MAX_ITEMS;
  const boundedItems = items.slice(0, SESSION_TRANSCRIPT_MAX_ITEMS);
  const size = approximateSize(boundedItems);
  return {
    version: 2,
    items: boundedItems,
    provenance: { updatedAt, revision },
    truncated,
    size
  };
}

/** P3：native payload 超限裁剪并留 provenance 的合并入口（raw_ref 唯一 merge writer 的前置）。 */
export function capTranscriptPayload<T>(payload: T, maxBytes = TRANSCRIPT_ITEM_PAYLOAD_MAX): { value: unknown; truncated: boolean } {
  if (approximateSize(payload) <= maxBytes) return { value: payload, truncated: false };
  return { value: { truncated: true, note: "native payload exceeded bound and was clipped" }, truncated: true };
}

export function envelopeWithinBound(envelope: TranscriptEnvelope, maxBytes = RAW_REF_ENVELOPE_MAX): boolean {
  return envelope.size <= maxBytes;
}

/** 近似 JSON 序列化大小；不序列化大对象（O(1) 估算，避免二次放大）。 */
export function approximateSize(value: unknown): number {
  switch (typeof value) {
    case "string": return value.length;
    case "number": return 8;
    case "boolean": return 1;
    case "undefined": return 0;
    case "object": {
      if (value === null) return 0;
      if (Array.isArray(value)) return value.reduce((acc, v) => acc + approximateSize(v), 0);
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.reduce((acc, [k, v]) => acc + k.length + 2 + approximateSize(v), 0);
    }
    default: return 16;
  }
}
