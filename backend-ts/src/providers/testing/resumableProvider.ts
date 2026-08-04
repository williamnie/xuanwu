import type {
  ExecutorCapability,
  ExecutorProvider,
  ProviderEvent,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  SessionRef
} from "../types.ts";

/**
 * P0 fixture：session-without-message-ref 形态。
 *
 * 有稳定 sessionRef（可跨 invocation resume），但没有稳定 message/turn ID。
 * 用于证明契约允许"可恢复但无上一 turn ID"的 Agent 自然接入
 * （计划 §3.1 目标：仅可恢复 Session；P1 验收：resume 不强制 message/turn ref）。
 *
 * 语义：
 * - run 返回 sessionRef（固定 session id），不返回 turnId；
 * - recover 在同一 session 上创建新 invocation，不依赖上一 message ref；
 * - 声明 resume_session + sessions capability。
 */
export class ResumableSessionProvider implements ExecutorProvider {
  readonly id = "fake-resumable" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session"];
  readonly runs: Array<{ input: ProviderRunInput; recovered?: boolean }> = [];

  #sessionRef(input: ProviderRunInput): SessionRef {
    return { provider: this.id, sessionId: `fake-resumable-session-${input.projectId}` };
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.runs.push({ input });
    const event: ProviderEvent = {
      provider: this.id,
      type: "provider.message",
      session: this.#sessionRef(input),
      text: "resumable provider started (no message ref)"
    };
    input.onEvent?.(event);
    return { runId: `fake-resumable-run-${input.issueId}`, session: this.#sessionRef(input) };
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.runs.push({ input, recovered: true });
    const event: ProviderEvent = {
      provider: this.id,
      type: "provider.message",
      session: this.#sessionRef(input),
      text: "resumable provider recovered on existing session"
    };
    input.onEvent?.(event);
    return { runId: `fake-resumable-run-${input.issueId}`, session: this.#sessionRef(input) };
  }
}
