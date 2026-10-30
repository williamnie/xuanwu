import { describe, expect, test } from "bun:test";
import { type CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES } from "../core/policyContracts.ts";

export class FakeCodexIssueAdapter {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readThreadResult: ThreadSummary | null = null;
  resumeThreadResult: ThreadSummary | null = null;
  startTurnError: Error | null = null;
  threadName?: string;

  async initialize(): Promise<CodexInitializeResult> {
    this.calls.push({ method: "initialize" });
    return { protocolVersion: "fixture", capabilities: {} };
  }

  async listThreads() { return { data: [], nextCursor: undefined }; }
  async listModels() { return { data: [] }; }

  async readThread(threadID: string, input: { includeTurns?: boolean } = {}): Promise<ThreadSummary> {
    this.calls.push({ method: "thread/read", params: { threadID, ...input } });
    return this.readThreadResult ?? this.threadSummary(threadID);
  }

  async listThreadTurns(threadID: string, input: Record<string, unknown> = {}) {
    this.calls.push({ method: "thread/turns/list", params: { threadID, ...input } });
    return { data: [], nextCursor: undefined };
  }

  async resumeThread(threadID: string): Promise<ThreadSummary> {
    this.calls.push({ method: "thread/resume", params: { threadID } });
    return this.resumeThreadResult ?? this.threadSummary(threadID);
  }

  async startThread(input: ThreadStartInput): Promise<ThreadStartResult> {
    this.calls.push({ method: "thread/start", params: input });
    return { ...this.threadSummary("thread-1"), thread_id: "thread-1" };
  }

  async setThreadName(threadID: string, name: string): Promise<{ ok: true; provider_session_id: string }> {
    this.calls.push({ method: "thread/name/set", params: { threadID, name } });
    this.threadName = name;
    return { ok: true, provider_session_id: threadID };
  }

  async startTurn(threadID: string, input: CodexUserInput[], options: TurnStartOptions = {}): Promise<TurnStartResult> {
    this.calls.push({ method: "turn/start", params: { threadID, input, options } });
    if (this.startTurnError) throw this.startTurnError;
    return { provider: "codex", provider_session_id: threadID, sessionId: threadID, turn_id: "turn-1" };
  }

  async steerTurn(threadID: string, turnID: string, input: CodexUserInput[]): Promise<TurnStartResult> {
    this.calls.push({ method: "turn/steer", params: { threadID, turnID, input } });
    return { provider: "codex", provider_session_id: threadID, sessionId: threadID, turn_id: turnID };
  }

  async interruptTurn(threadID: string, turnID: string) {
    this.calls.push({ method: "turn/interrupt", params: { threadID, turnID } });
    return { ok: true as const, provider_session_id: threadID, turn_id: turnID };
  }

  private threadSummary(threadID: string): ThreadSummary {
    return {
      id: `codex:${threadID}`, provider: "codex", provider_session_id: threadID, sessionId: threadID, ephemeral: false,
      name: this.threadName, createdAt: Date.parse("2026-09-02T16:00:00Z") / 1000
    };
  }
}

export class FakeCodexEventSource {
  readonly handlers = new Set<CodexEventHandler>();

  emit(event: ProviderEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: CodexEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export class FakeCodexRuntimeControl {
  acquired: string[] = [];
  released = 0;

  acquire(owner: string) {
    this.acquired.push(owner);
    return {
      bind: () => {},
      release: () => { this.released += 1; }
    };
  }

  releaseSession(): void {}
  runtimeSnapshot() { return { idle_ttl_ms: 15_000, owners: [] }; }
  async stop(): Promise<void> {}
}
