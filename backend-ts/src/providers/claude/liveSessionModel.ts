import type { CanUseTool, Options as ClaudeSdkOptions, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderEvent, type ProviderRunResult, type SessionRef } from "../types.ts";
import { type ClaudeLiveSession } from "./liveSession.ts";

export const PROVIDER = "claude" as const;

/** CLI 只有打开该开关才发 session_state_changed；idle 是官方认定的“整轮结束”信号。 */
export const CLAUDE_SESSION_STATE_EVENTS_ENV = "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS";

export const INTERRUPT_GRACE_MS = 3_000;

/** 新进程迟迟不回首条消息时，不让“提交即返回”的调用方一直等；轮本身继续受 timeoutMs 约束。 */
export const ACCEPT_WAIT_MS = 10_000;

export type ClaudeLiveQuery = AsyncIterable<unknown> & {
  close?: () => void;
  interrupt?: () => Promise<void>;
};

export type ClaudeLiveTurnRequest = {
  /** 提交给 CLI 的 user message uuid，也是会话历史里这一轮的 turn id。 */
  id: string;
  prompt: string;
  /** 进程级参数指纹；不同指纹的消息必须换进程（resume）后再发。 */
  key: string;
  options: ClaudeSdkOptions;
  onEvent?: (event: ProviderEvent) => void;
  canUseTool?: (session: () => SessionRef | undefined) => CanUseTool;
  rejectApprovals: (reason: string) => void;
  timeoutMs: number;
};

export type ClaudeLiveSessionHost = {
  emit(event: ProviderEvent, onEvent?: (event: ProviderEvent) => void): void;
  /** 回调里拿到的是已补齐 sessionId/resume/abortController/canUseTool 的最终参数。 */
  startQuery(prompt: AsyncIterable<unknown>, options: ClaudeSdkOptions): ClaudeLiveQuery;
  sessionInfo(sessionId: string, cwd: string): Promise<SDKSessionInfo | undefined>;
  sessionStarted(sessionId: string, resumed: boolean, onEvent?: (event: ProviderEvent) => void): void;
  idleTimeoutMs: number;
  /** 进程与待发消息都清空后通知 provider 释放映射。 */
  released(session: ClaudeLiveSession): void;
};

export type LiveProcess = {
  abort: AbortController;
  input: InputQueue;
  key: string;
  query: ClaudeLiveQuery;
  stateEvents: boolean;
};

export type ClaudeLiveSubmission = {
  turnId: string;
  /** 进程已接手（首条 SDK 消息到达、或已在本地排队）即 resolve，用于“提交即返回”。 */
  accepted: Promise<void>;
  done: Promise<ProviderRunResult>;
};

export type InputQueue = { iterable: AsyncIterable<unknown>; push(message: unknown): void; close(): void };

export function createInputQueue(): InputQueue {
  const items: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    iterable: (async function* () {
      while (!closed) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    })(),
    push(message) {
      if (closed) return;
      items.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    }
  };
}

export async function boundedInterrupt(query: ClaudeLiveQuery | undefined, timeoutMs: number): Promise<void> {
  const interrupt = query?.interrupt;
  if (!interrupt) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      interrupt.call(query),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
