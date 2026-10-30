import { type Options as ClaudeSdkOptions, type GetSessionMessagesOptions, type SDKSessionInfo, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { type ClaudeCliAuthInspection, type ClaudeCliProviderOptions, type ClaudeProcessFactory } from "./cliProvider.ts";
import { type ProviderEvent } from "../types.ts";

export const PROVIDER = "claude" as const;

export const DEFAULT_MAX_TURNS = 50;

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export const CLAUDE_AGENT_SDK_VERSION = "0.3.312";

export type QueryInput = { prompt: string | AsyncIterable<unknown>; options?: ClaudeSdkOptions };

export type ClaudeQuery = AsyncIterable<unknown> & {
  close?: () => void;
  interrupt?: () => Promise<void>;
};

export type ClaudeQueryFactory = (input: QueryInput) => ClaudeQuery;

export type ClaudeSessionFunctions = {
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  listSessions(options?: { dir?: string; limit?: number; offset?: number }): Promise<SDKSessionInfo[]>;
};

export type ClaudeSdkProviderOptions = {
  authInspector?: (config: ProviderRuntimeConfig) => ClaudeCliAuthInspection;
  eventSink?: (event: ProviderEvent) => void;
  /** 常驻 Claude 进程空闲多久后释放；释放后下一条消息自动 resume。 */
  idleTimeoutMs?: number;
  queryFactory?: ClaudeQueryFactory;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<ClaudeSessionFunctions>;
  skipReadinessCheck?: boolean;
};

export type ClaudeProviderOptions = ClaudeSdkProviderOptions & ClaudeCliProviderOptions;
