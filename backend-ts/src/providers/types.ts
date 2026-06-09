export const EXECUTOR_PROVIDER_IDS = ["codex", "claude", "fake-execution-only"] as const;

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
};

export type ProviderRunInput = {
  issueId: number;
  projectId: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
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

export type SessionListInput = { cursor?: string; limit?: number };
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
  mode?: string;
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
}

export function isExecutorProviderId(value: string): value is ExecutorProviderId {
  return EXECUTOR_PROVIDER_IDS.includes(value as ExecutorProviderId);
}
