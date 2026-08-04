import { ExecutionOnlyProvider } from "./executionOnlyProvider.ts";
import { ResumableSessionProvider } from "./resumableProvider.ts";
import { FullSessionProvider } from "./fullSessionProvider.ts";

/**
 * P0 conformance fixtures：三类 Provider 形态（计划 §19 P0）。
 *
 * - execution-only：仅 issue_execution，不写 Session、不提供 resume/interrupt；
 * - session-without-message-ref：可恢复但无稳定 turn/message ID；
 * - full-session：Codex-like，声明全部 Session/control/approval/model_list capability。
 *
 * 供 conformance suite（P2）与现有 runner/http 测试复用，避免每个测试文件重复定义 fake provider。
 */
export const CONFORMANCE_FIXTURES = {
  executionOnly: new ExecutionOnlyProvider(),
  resumable: new ResumableSessionProvider(),
  fullSession: new FullSessionProvider()
} as const;

export { ExecutionOnlyProvider, ResumableSessionProvider, FullSessionProvider };

export type FixtureKind = keyof typeof CONFORMANCE_FIXTURES;

export function fixtureById(id: string) {
  const providers = Object.values(CONFORMANCE_FIXTURES);
  return providers.find((p) => p.id === id);
}
