import type { CanUseTool, ModelInfo, Options, Query, SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactSensitiveText } from "../../util/redact.ts";
import { type QoderFailureDetails } from "./events.ts";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";

export type QoderTerminal = "succeeded" | "failed" | "interrupted" | "cancelled";

export type QoderRunOptions = {
  approvalPolicy?: string;
  canUseTool?: CanUseTool;
  cwd: string;
  invocationKey: string;
  model?: string;
  policy?: ResolvedExecutionPolicy;
  reasoningEffort?: string;
  /** 仅用于预分配新 Session；恢复历史 Session 必须使用 resume。 */
  sessionId?: string;
  resume?: string;
  sandbox?: string;
  systemPrompt?: string;
};

export type QoderQueryResult = {
  invocationRef: string;
  messageRef: string;
  sessionId: string;
  terminal: QoderTerminal;
  usage?: QoderUsageProjection;
};

export type QoderUsageProjection = {
  assistant_requests: Array<Record<string, unknown>>;
  credits: {
    request?: { billable?: boolean; original_value?: number; provenance: "result.usage"; value: number };
    session?: {
      completeness: "partial";
      provenance: "query.getUsageInfo.session" | "result.total_credits";
      semantics: "session_cumulative_unverified";
      value: number;
    };
  };
  model_usage: Record<string, Record<string, unknown>>;
  money: { completeness: "unavailable"; reason: "qoder_credits_are_not_currency" };
  result: {
    cached_input_tokens?: number;
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
    provenance: "result.usage";
    total_tokens: number;
  };
};

export type QoderMessageContext = {
  interrupted: boolean;
  usage?: QoderUsageProjection;
};

export type QoderProcessLease = {
  commandLabel: string;
  invocationOwner: string;
  pgid?: number;
  pid: number;
  startedAt: string;
};

export class QoderExecutionError extends Error {
  override readonly name = "QoderExecutionError";
  constructor(readonly details: QoderFailureDetails) {
    super(redactSensitiveText(details.message));
  }
}

export interface QoderSdkFacade {
  readonly available: boolean;
  run(
    prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: QoderMessageContext) => void
  ): Promise<QoderQueryResult>;
  listModels(): Promise<ModelInfo[]>;
  /** 精确中断 invocation 对应的 active Query。 */
  interrupt(invocationKey: string): Promise<void>;
  activeCount(): number;
  processLeases(): readonly QoderProcessLease[];
  close(): Promise<void>;
}

export type QoderSdkFacadeOptions = {
  /** Offline fake-stream seam; production uses the pinned SDK query export. */
  queryFactory?: (input: { prompt: string; options: Options }) => Query;
  /** Offline control-query seam; production starts a prompt-free SDK query. */
  discoveryQueryFactory?: (input: { options: Options; prompt: AsyncIterable<never> }) => Promise<Query> | Query;
  modelDiscoveryTimeoutMs?: number;
  modelCacheTtlMs?: number;
  now?: () => number;
};

export const DEFAULT_QODER_MODEL_DISCOVERY_TIMEOUT_MS = 12_000;

export const QODER_HOST_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA"
] as const;
