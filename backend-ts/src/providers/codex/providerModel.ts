import { CodexAdapter } from "./adapter.ts";
import type { AppEvent } from "../../events/bus.ts";
import type { ApprovalDecision, ProviderEvent } from "../types.ts";
import type { CodexInitializeResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import { CodexStdioJsonRpcTransport, type CodexProcessLease } from "./jsonRpc.ts";

export const PROVIDER_CODEX = "codex";

export const DEFAULT_DEVELOPER_INSTRUCTIONS = [
  "Keep changes scoped to the runner issue.",
  "You are executing an Issue already claimed by Xuanwu. Never use Xuanwu CLI or API lifecycle commands to create, deduplicate, enqueue, retry, cancel, delete, or change the status of the current Issue, and never stop its current Run.",
  "Report the result with the RUNNER_OUTCOME marker required by the execution context; the Host reconciles the Run and PI alone decides semantic Issue status."
].join(" ");

export type CodexIssueAdapter = {
  initialize(): Promise<CodexInitializeResult>;
  refreshAccount?(): Promise<void>;
  listThreads(input?: Parameters<CodexAdapter["listThreads"]>[0]): Promise<Awaited<ReturnType<CodexAdapter["listThreads"]>>>;
  listThreadTurns(threadID: string, input?: Parameters<CodexAdapter["listThreadTurns"]>[1]): Promise<Awaited<ReturnType<CodexAdapter["listThreadTurns"]>>>;
  readThread(threadID: string, input?: Parameters<CodexAdapter["readThread"]>[1]): Promise<ThreadSummary>;
  resumeThread(threadID: string): Promise<ThreadSummary>;
  setThreadName(threadID: string, name: string): Promise<{ ok: true; provider_session_id: string }>;
  startThread(input: Parameters<CodexAdapter["startThread"]>[0]): Promise<Awaited<ReturnType<CodexAdapter["startThread"]>>>;
  startTurn(threadID: string, input: Parameters<CodexAdapter["startTurn"]>[1], options?: Parameters<CodexAdapter["startTurn"]>[2]): Promise<TurnStartResult>;
  steerTurn(threadID: string, turnID: string, input: Parameters<CodexAdapter["steerTurn"]>[2]): Promise<TurnStartResult>;
  interruptTurn(threadID: string, turnID: string): Promise<Awaited<ReturnType<CodexAdapter["interruptTurn"]>>>;
  listModels(): Promise<unknown>;
  resolveApproval?(requestId: string, decision: ApprovalDecision): Promise<unknown>;
};

export type CodexEventHandler = (event: ProviderEvent) => void;

export type CodexEventSource = { subscribe(handler: CodexEventHandler): () => void };

export type CodexAppEventSink = (event: AppEvent) => void;

export type CodexRuntimeControl = {
  acquire(owner: string): CodexProcessLease;
  releaseSession(sessionID: string, turnID?: string): void;
  runtimeSnapshot(): ReturnType<CodexStdioJsonRpcTransport["runtimeSnapshot"]>;
  stop(): Promise<void>;
};

export class CodexEventHub implements CodexEventSource {
  readonly handlers = new Set<CodexEventHandler>();

  publish(event: ProviderEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: CodexEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
