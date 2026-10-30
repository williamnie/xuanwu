import { type Issue } from "../db/repositories/issues.ts";
import type { EventBus } from "../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";

export type InterruptRuntime = {
  bus?: Pick<EventBus, "publish">;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type SessionInterruptResult = {
  interrupted: boolean;
  issue?: Issue;
};

export const DEFAULT_INTERRUPT_TIMEOUT_MS = 2000;

export const ISSUE_CANCEL_REASON = "issue_cancel";

export const ISSUE_RETRY_REASON = "issue_retry";

export const SESSION_INTERRUPT_REASON = "session_interrupt";
