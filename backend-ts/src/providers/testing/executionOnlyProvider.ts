import type {
  ExecutorCapability,
  ExecutorProvider,
  ProviderEvent,
  ProviderRunInput,
  ProviderRunResult
} from "../types.ts";

/**
 * P0 fixture：execution-only 形态。
 *
 * 仅声明 `issue_execution`，不提供 Session、resume、interrupt、approval 或 model list。
 * 用于证明 Provider Core v2 的契约不要求 execution-only Provider 伪造 Session/turn
 * （计划 §3.1 目标：一次性 execution-only 也能完成 Attempt 而不写 `agent_sessions`）。
 *
 * 语义：
 * - run 建立本地 invocation anchor（invocationRef），返回 runId；
 * - 不产生 sessionRef / messageRef / cursorRef；
 * - recover/resume 明确拒绝（capability 未声明）。
 */
export class ExecutionOnlyProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution"];
  readonly inputs: ProviderRunInput[] = [];
  readonly emitted: ProviderEvent[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const event: ProviderEvent = {
      provider: this.id,
      type: "provider.message",
      text: "execution-only provider started"
    };
    this.emitted.push(event);
    input.onEvent?.(event);
    return { runId: `fake-execution-${input.issueId}` };
  }
}
