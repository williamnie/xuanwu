import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderEvent, type ProviderRunResult, type SessionRef } from "../types.ts";
import { createClaudeSdkStreamState, type ClaudeSdkStreamState } from "./sdkStream.ts";
import { type ClaudeLiveTurnRequest, type LiveProcess, PROVIDER } from "./liveSessionModel.ts";

export type Turn = {
  request: ClaudeLiveTurnRequest;
  proc?: LiveProcess;
  state: ClaudeSdkStreamState;
  heldResult?: ProviderEvent[];
  /** 派发后进程是否已回过任何消息；没回就退出的轮可以安全地换进程重发一次。 */
  answered: boolean;
  redispatched: boolean;
  resultSeen: boolean;
  interrupted?: string;
  timedOut?: string;
  timer?: ReturnType<typeof setTimeout>;
  accepted: () => void;
  resolve: (result: ProviderRunResult) => void;
  reject: (error: Error) => void;
  callback?: CanUseTool;
};

export function asProgress(event: ProviderEvent): ProviderEvent {
  if (!event.runEvent?.terminal) return event;
  return {
    ...event,
    type: "status",
    status: "superseded",
    runEvent: { ...event.runEvent, kind: "progress", outcome: "running", terminal: false }
  };
}

export function scratchState(sessionId: string): ClaudeSdkStreamState {
  const state = createClaudeSdkStreamState();
  state.sessionId = sessionId;
  return state;
}

export function sessionRef(state: ClaudeSdkStreamState): SessionRef | undefined {
  if (!state.sessionId) return undefined;
  return { provider: PROVIDER, sessionId: state.sessionId, ...(state.turnId ? { turnId: state.turnId } : {}) };
}

export function userMessage(uuid: string, sessionId: string, prompt: string, priority?: "next") {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    message: { role: "user", content: prompt }
  };
}

export function createClaudeLiveTurn(request: ClaudeLiveTurnRequest, sessionId: string) {
    let accepted!: () => void;
    let refuse!: (error: Error) => void;
    const acceptedPromise = new Promise<void>((resolve, rejectAccepted) => { accepted = resolve; refuse = rejectAccepted; });
    // run() 只等 done；未被等待的 accepted 失败不能变成未处理拒绝。
    acceptedPromise.catch(() => undefined);
    let resolve!: (result: ProviderRunResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<ProviderRunResult>((resolveDone, rejectDone) => { resolve = resolveDone; reject = rejectDone; });
    const state = createClaudeSdkStreamState();
    state.sessionId = sessionId;
    const turn: Turn = { request, state, answered: false, redispatched: false, resultSeen: false, accepted, resolve, reject };
    // 进程接手前就失败时，“提交即返回”的调用方也必须拿到这个错误。
    done.catch(refuse);
  return { turn, accepted, acceptedPromise, done };
}
