import type { ExecutorProviderId } from "../types.ts";

export const PROVIDER_SESSION_VIEW_CONTRACT = "xw.provider-session.v1" as const;

export type ProviderSessionTurn = {
  id: string;
  items: Array<Record<string, unknown>>;
};

export type ProviderSessionView = Record<string, unknown> & {
  session_contract: typeof PROVIDER_SESSION_VIEW_CONTRACT;
  id: string;
  provider: ExecutorProviderId;
  provider_session_id: string;
  sessionId: string;
  thread_id: string;
  name: string;
  preview: string;
  cwd: string;
  status: unknown;
  isRunning: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ProviderSessionDetailView = ProviderSessionView & {
  turns: ProviderSessionTurn[];
};

export type ProviderSessionViewCandidate = {
  sessionRef: string;
  name?: string;
  preview?: string;
  cwd?: string;
  status?: unknown;
  isRunning?: boolean;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  turns?: ProviderSessionTurn[];
  extensions?: Record<string, unknown>;
};

/**
 * Adapter 输出的唯一 Session View builder。
 * 每个 adapter 负责 native shape -> candidate；Core 只冻结公共 identity、状态和 transcript 外壳。
 */
export function providerSessionSummary(
  provider: ExecutorProviderId,
  candidate: ProviderSessionViewCandidate
): ProviderSessionView {
  const sessionRef = candidate.sessionRef.trim();
  if (!sessionRef) throw new Error(`provider "${provider}" session adapter returned an empty session ref`);
  const running = candidate.isRunning === true;
  return {
    ...sessionExtensions(candidate.extensions),
    session_contract: PROVIDER_SESSION_VIEW_CONTRACT,
    id: `${provider}:${sessionRef}`,
    provider,
    provider_session_id: sessionRef,
    sessionId: sessionRef,
    thread_id: sessionRef,
    name: candidate.name?.trim() ?? "",
    preview: candidate.preview?.trim() ?? "",
    cwd: candidate.cwd?.trim() ?? "",
    status: candidate.status ?? (running ? "running" : "idle"),
    isRunning: running,
    createdAt: finiteTimestamp(candidate.createdAt),
    updatedAt: finiteTimestamp(candidate.updatedAt),
    ...(candidate.model?.trim() ? { model: candidate.model.trim() } : {})
  };
}

export function providerSessionDetail(
  provider: ExecutorProviderId,
  candidate: ProviderSessionViewCandidate
): ProviderSessionDetailView {
  return {
    ...providerSessionSummary(provider, candidate),
    turns: Array.isArray(candidate.turns) ? candidate.turns : []
  };
}

/**
 * HTTP 边界的 fail-closed 校验。只有 manifest 声明了 Session View 契约的 adapter 才启用，
 * 便于旧 adapter 在迁移窗口内继续工作，同时防止已迁移 adapter 回退为 native shape。
 */
export function assertProviderSessionView(
  provider: ExecutorProviderId,
  value: Record<string, unknown>,
  options: { detail?: boolean } = {}
): asserts value is ProviderSessionView | ProviderSessionDetailView {
  const sessionRef = stringValue(value.provider_session_id);
  const expectedID = sessionRef ? `${provider}:${sessionRef}` : "";
  const valid = value.session_contract === PROVIDER_SESSION_VIEW_CONTRACT &&
    value.provider === provider &&
    sessionRef !== "" &&
    value.id === expectedID &&
    value.sessionId === sessionRef &&
    value.thread_id === sessionRef &&
    typeof value.name === "string" &&
    typeof value.preview === "string" &&
    typeof value.cwd === "string" &&
    value.status !== undefined &&
    typeof value.isRunning === "boolean" &&
    finiteNumber(value.createdAt) &&
    finiteNumber(value.updatedAt) &&
    (value.model === undefined || typeof value.model === "string") &&
    (!options.detail || validTurns(value.turns));
  if (!valid) {
    throw new Error(`provider "${provider}" session adapter returned an invalid ${PROVIDER_SESSION_VIEW_CONTRACT} view`);
  }
}

function finiteTimestamp(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validTurns(value: unknown): value is ProviderSessionTurn[] {
  return Array.isArray(value) && value.every((turn) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return false;
    const record = turn as Record<string, unknown>;
    return typeof record.id === "string" && Array.isArray(record.items) &&
      record.items.every(validTurnItem);
  });
}

function validTurnItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.type === "userMessage") {
    return Array.isArray(item.content) && item.content.length > 0 && item.content.every((part) =>
      Boolean(part) && typeof part === "object" && !Array.isArray(part)
    );
  }
  if (item.type === "agentMessage") return typeof item.text === "string";
  return true;
}

function sessionExtensions(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const reserved = new Set([
    "session_contract", "id", "provider", "provider_session_id", "sessionId", "thread_id",
    "name", "preview", "cwd", "status", "isRunning", "createdAt", "updatedAt", "model", "turns"
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !reserved.has(key)));
}
