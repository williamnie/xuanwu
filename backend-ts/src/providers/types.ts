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

export type InterruptInput = {
  session: SessionRef;
  reason?: string;
};

export interface ExecutorProvider {
  id: ExecutorProviderId;
  capabilities: readonly ExecutorCapability[];
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
  recover?(input: ProviderRecoveryInput): Promise<ProviderRunResult>;
  events?(): AsyncIterable<ProviderEvent>;
  interrupt?(input: InterruptInput): Promise<void>;
}

export function isExecutorProviderId(value: string): value is ExecutorProviderId {
  return EXECUTOR_PROVIDER_IDS.includes(value as ExecutorProviderId);
}
