import type { RunCost } from "../domain/run/contracts.ts";

// --- P1：ProviderId（branded string，替代闭合联合）---
// 格式：^[a-z0-9][a-z0-9._-]{0,63}$；禁止 ":"（外部 Session key 为 `<provider>:<session_ref>`）。
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ProviderId = string & { readonly __brand: "ProviderId" };

/** 校验并构造 ProviderId；非法格式（含冒号/空/大写开头/超长）抛错。 */
export function asProviderId(value: string): ProviderId {
  if (typeof value !== "string" || !PROVIDER_ID_RE.test(value)) {
    throw new Error(`invalid provider id: ${JSON.stringify(value)}`);
  }
  return value as ProviderId;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_ID_RE.test(value);
}

// --- P1：ProviderExecutionRef（canonical execution refs）---
// invocationRef 必需；session/message/cursor 均为可选，语义见 0089 计划 §6.2。
export type ProviderExecutionRef = {
  providerId: ProviderId;
  invocationRef: string;
  sessionRef?: string;
  messageRef?: string;
  cursorRef?: string;
};

/**
 * P1：legacy SessionRef（codex thread/turn 术语）→ ProviderExecutionRef 映射 adapter。
 * invocationRef 由调用方提供（如 `run_attempts.provider_invocation_ref`）；
 * 无原生 invocation 时使用持久化 intent 派生的本地 ref（计划 §6.2）。
 */
export function executionRefFromSessionRef(session: SessionRef, invocationRef: string): ProviderExecutionRef {
  return {
    providerId: asProviderId(session.provider),
    invocationRef,
    sessionRef: session.sessionId,
    ...(session.turnId === undefined ? {} : { messageRef: session.turnId })
  };
}

/** P1：ProviderExecutionRef → legacy SessionRef（兼容消费者用；仅当有 sessionRef 时返回）。 */
export function sessionRefFromExecutionRef(ref: ProviderExecutionRef): SessionRef | undefined {
  if (ref.sessionRef === undefined) return undefined;
  return {
    provider: ref.providerId,
    sessionId: ref.sessionRef,
    ...(ref.messageRef === undefined ? {} : { turnId: ref.messageRef })
  };
}

export const EXECUTOR_PROVIDER_IDS = ["codex", "claude", "fake-execution-only", "fake-resumable", "fake-full-session", "pi", "qoder"] as const;

export type ExecutorProviderId = (typeof EXECUTOR_PROVIDER_IDS)[number];

export type ExecutorCapability =
  | "issue_execution"
  | "sessions"
  | "resume_session"
  | "interrupt"
  | "approvals"
  | "model_list";

export type SessionRef = {
  provider: ExecutorProviderId;
  sessionId: string;
  turnId?: string;
};

export const NORMALIZED_RUN_EVENT_CONTRACT = "xw.run-event.v1" as const;

export type NormalizedRunEventKind =
  | "started"
  | "progress"
  | "approval_requested"
  | "approval_resolved"
  | "error"
  | "completed"
  | "unknown";

export type NormalizedRunEventOutcome =
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type ProviderMetadataValue = boolean | number | string;

export type NormalizedRunEvent = {
  contract: typeof NORMALIZED_RUN_EVENT_CONTRACT;
  cost?: RunCost;
  kind: NormalizedRunEventKind;
  metadata: Record<string, ProviderMetadataValue>;
  outcome: NormalizedRunEventOutcome;
  provider: ExecutorProviderId;
  retryable?: boolean;
  source: { method: string; ref: string };
  terminal: boolean;
  unknown?: { policy: "preserve"; reason: "unsupported_provider_event" };
};

export type ProviderEvent = {
  type: string;
  provider: ExecutorProviderId;
  session?: SessionRef;
  text?: string;
  command?: string;
  path?: string;
  status?: string;
  error?: string;
  payload?: unknown;
  raw?: { method?: string; payload?: unknown };
  runEvent?: NormalizedRunEvent;
};

export type ProviderPromptImage = {
  detail?: "high" | "original";
  path: string;
  type: "localImage";
};

export type ProviderRunInput = {
  issueId: number;
  projectId: string;
  cwd: string;
  prompt: string;
  images?: ProviderPromptImage[];
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  serviceTierSource?: string;
  approvalPolicy?: string;
  sandbox?: string;
  onEvent?: (event: ProviderEvent) => void;
};

export type ProviderRecoveryInput = ProviderRunInput & {
  session: SessionRef;
};

export type ProviderRunResult = {
  runId: string;
  session?: SessionRef;
};

export type ProviderRuntimeStatus = {
  active_sessions: number;
  api_key_configured: boolean;
  auth_configured?: boolean;
  auth_mode?: string;
  auth_source?: string;
  executable_ready?: boolean;
  mode: string;
  ready: boolean;
  reason?: string;
  platform_profile?: Record<string, boolean | string>;
  version: string;
};

export type SessionListInput = { cursor?: string; cwd?: string; limit?: number };
export type SessionListResult = {
  backwardsCursor?: string;
  data: Array<Record<string, unknown>>;
  nextCursor?: string;
};
export type SessionCreateInput = {
  approvalPolicy?: string;
  cwd: string;
  model?: string;
  projectId?: string;
  prompt?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandbox?: string;
};
export type SessionCreateResult = {
  id: string;
  provider: ExecutorProviderId;
  provider_session_id: string;
  provider_turn_id?: string;
  thread_id: string;
  turn_id?: string;
};
export type SessionMessageInput = Omit<SessionCreateInput, "cwd" | "projectId"> & {
  cwd?: string;
  mode?: string;
  projectId?: string;
  sessionId: string;
  turnId?: string;
};
export type SessionMessageResult = {
  provider: ExecutorProviderId;
  provider_session_id: string;
  sessionId: string;
  turn_id: string;
};

export type InterruptInput = {
  session: SessionRef;
  reason?: string;
};
export type ApprovalDecision = { decision: string; scope?: string };

export interface ExecutorProvider {
  id: ExecutorProviderId;
  capabilities: readonly ExecutorCapability[];
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
  createSession?(input: SessionCreateInput): Promise<SessionCreateResult>;
  recover?(input: ProviderRecoveryInput): Promise<ProviderRunResult>;
  events?(): AsyncIterable<ProviderEvent>;
  interrupt?(input: InterruptInput): Promise<void>;
  listSessions?(input: SessionListInput): Promise<SessionListResult>;
  readSession?(sessionId: string): Promise<Record<string, unknown>>;
  sendSessionMessage?(input: SessionMessageInput): Promise<SessionMessageResult>;
  listModels?(): Promise<unknown>;
  resolveApproval?(requestId: string, decision: ApprovalDecision): Promise<void>;
  runtimeStatus?(): ProviderRuntimeStatus;
  stop?(): Promise<void>;
}

export function isExecutorProviderId(value: string): value is ExecutorProviderId {
  return EXECUTOR_PROVIDER_IDS.includes(value as ExecutorProviderId);
}
