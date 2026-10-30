import { describe, expect, test } from "bun:test";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import type { ProviderEvent } from "../types.ts";

export const cwd = import.meta.dir;

export function sdkProvider(sessionId: string, factory: () => AsyncGenerator<unknown>): ClaudeSdkExecutorProvider {
  return new ClaudeSdkExecutorProvider(config(), {
    queryFactory: (() => factory() as ClaudeQuery) as ClaudeQueryFactory,
    sessionIdFactory: () => sessionId
  });
}

export function config(overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  return { ...baseConfig(), ...overrides };
}

export function baseConfig() {
  return { command: "claude", cwd, env: {}, mode: "sdk" as const, model: "", timeoutMs: 5_000 };
}

export function runInput(onEvent?: (event: ProviderEvent) => void) {
  return { issueId: 1, projectId: "project", cwd, prompt: "run", onEvent };
}

export function init(sessionId: string, uuid: string) {
  return { type: "system", subtype: "init", session_id: sessionId, uuid, model: "claude", permissionMode: "dontAsk" };
}

export function success(sessionId: string, uuid: string, extra: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: sessionId,
    uuid,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra
  };
}

export function fromMessages(messages: unknown[]): ClaudeQuery {
  return (async function* () {
    for (const message of messages) yield message;
  })() as ClaudeQuery;
}

export function waitingQuery(messages: unknown[], controls: { close(): void; interrupt(): Promise<void> }): ClaudeQuery {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const iterable = (async function* () {
    for (const message of messages) yield message;
    await done;
  })() as ClaudeQuery;
  iterable.interrupt = async () => { await controls.interrupt(); finish(); };
  iterable.close = () => { controls.close(); finish(); };
  return iterable;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for condition");
}
