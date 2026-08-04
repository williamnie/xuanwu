import type { ProviderExecutionRef } from "../types.ts";

/**
 * P3：legacy `thread_id/turn_id` projection 单一来源（设计 §4.4）。
 * 所有 HTTP 响应、`agent_sessions` upsert、`issue_events` payload 的
 * `thread_id/turn_id` 统一调用此函数；adapter 不重复拼接。
 * 无 sessionRef（execution-only）→ 空 thread_id，不伪造 Codex 字段。
 */
export function legacySessionFields(ref: Partial<ProviderExecutionRef> | undefined): { thread_id: string; turn_id: string } {
  return {
    thread_id: ref?.sessionRef ?? "",
    turn_id: ref?.messageRef ?? ""
  };
}
