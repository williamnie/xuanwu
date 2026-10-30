import { type GetSessionMessagesOptions, type SDKSessionInfo, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { type ProviderEvent, type ProviderRunInput, type SessionCreateInput } from "../types.ts";

export const PROVIDER = "claude";

export const DEFAULT_MAX_TURNS = "50";

export const STDERR_LIMIT = 4096;

export type ClaudeProcess = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): unknown;
};

export type ClaudeProcessFactory = (options: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => ClaudeProcess;

export type ClaudeCliAuthInspection = {
  auth_method?: string;
  checked: boolean;
  logged_in: boolean;
  provider?: string;
};

export type ClaudeCliProviderOptions = {
  authInspector?: (config: ProviderRuntimeConfig) => ClaudeCliAuthInspection;
  processFactory?: ClaudeProcessFactory;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<ClaudeCliSessionFunctions>;
};

export type ActiveClaudeProcess = {
  interrupted: boolean;
  process: ClaudeProcess;
  reason: string;
};

export type ClaudeCliSessionFunctions = {
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  listSessions(options?: { dir?: string; limit?: number; offset?: number }): Promise<SDKSessionInfo[]>;
};

export type ClaudeCliExecutionInput = Pick<SessionCreateInput,
  "approvalPolicy" | "cwd" | "model" | "prompt" | "reasoningEffort" | "sandbox" | "serviceTier"
> & Pick<ProviderRunInput, "policy"> & {
  issueId?: number;
  onEvent?: (event: ProviderEvent) => void;
};

export const cliAuthCache = new Map<string, { expiresAt: number; inspection: ClaudeCliAuthInspection }>();

export const CLI_AUTH_CACHE_MS = 5_000;
