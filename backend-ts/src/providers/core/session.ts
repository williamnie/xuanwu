import type { ProviderExecutionRef, ProviderId } from "../types.ts";

/**
 * P3：Session v2 标准合同（设计 §9 / §3.6）。
 * Session API 不再依赖 Codex thread/turn 或任意 record shape；
 * 列表只读 Summary（永不加载完整 transcript），Detail 才含 transcript。
 */

export type TranscriptItemKind = "message" | "tool" | "approval" | "error" | "unknown";

export type TranscriptItem = {
  /** provider-neutral item id（messageRef 或本地顺序 id）；空串表示无稳定 id */
  id: string;
  kind: TranscriptItemKind;
  role?: "user" | "assistant" | "system";
  text?: string;
  /** bounded payload：adapter 已脱敏/裁剪（设计 §3.3） */
  payload?: unknown;
  refs?: Partial<ProviderExecutionRef>;
  createdAt?: string;
  /** native provenance：原始事件类型/版本/裁剪后大小 */
  providerNative?: { type: string; version: number; size: number };
};

export type SessionStatus = "active" | "idle" | "archived" | "unknown";

/**
 * P3：SessionSummary——列表项，不含 transcript。
 * legacy `thread_id/turn_id` 由 core/legacyProjection.ts 单一来源投影（§4.4）。
 */
export type SessionSummary = {
  /** dedupe key：`<providerId>:<sessionRef>`（§3.6） */
  id: string;
  providerId: ProviderId;
  sessionRef: string;
  title: string;
  preview: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** legacy projection（单一来源，§4.4） */
  thread_id: string;
  turn_id: string;
  providerSessionId: string;
};

export type SessionDetail = SessionSummary & {
  transcript: TranscriptItem[];
  /** provider opaque cursor：transcript 分页（下一页从此继续） */
  cursor?: string;
  native?: { version: number; size: number; truncated: boolean };
};

export type SessionMutationResult = {
  id: string;
  providerId: ProviderId;
  sessionRef: string;
  messageRef?: string;
  /** legacy projection（单一来源，§4.4） */
  thread_id: string;
  turn_id: string;
  status?: string;
};

/** P3：聚合分页 composite cursor（§3.6）。 */
export type ProviderSessionCursorV1 = {
  version: 1;
  dbWatermark: string;
  perProvider: Record<string, string>;
  sortKey: "updated_at" | "created_at";
  filterDigest: string;
};

export type ProviderSessionPage = {
  data: SessionSummary[];
  nextCursor?: string;
  providerErrors?: Array<{ provider: ProviderId; category: string; message: string }>;
};

/** P3：payload size 限制（有界性合同）。 */
export const SESSION_PREVIEW_MAX = 500;
export const TRANSCRIPT_ITEM_PAYLOAD_MAX = 64 * 1024;
export const SESSION_TRANSCRIPT_MAX_ITEMS = 200;
export const RAW_REF_ENVELOPE_MAX = 32 * 1024;

export function sessionDedupeKey(providerId: ProviderId, sessionRef: string): string {
  return `${providerId}:${sessionRef}`;
}

/** P3：SessionDetail → SessionSummary 投影（列表永不加载完整 transcript）。 */
export function summaryFromDetail(detail: SessionDetail): SessionSummary {
  const { transcript: _transcript, cursor: _cursor, native: _native, ...summary } = detail;
  return summary;
}
