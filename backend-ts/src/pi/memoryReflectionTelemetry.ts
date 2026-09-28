import type { RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import type { MemoryReflection } from "./memoryReflectionQueue.ts";

// 只计结构化用量，不保存模型文本、错误原文或租约 token。
export type ReflectionUsage = {
  model_calls: number | null; completed_calls: number | null;
  input_bytes: number | null; output_bytes: number | null;
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
  cost_usd: number | null;
};

export function unknownReflectionUsage(): ReflectionUsage {
  return { model_calls: null, completed_calls: null, input_bytes: null, output_bytes: null,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null };
}

export function reflectionReasonCode(reason: string, status: string): string {
  const known = ["project_disabled", "before_enabled_window", "source_memory_suppressed", "evidence_summary_incomplete",
    "no_valid_evidence", "input_budget_exceeded", "crash_retry_exhausted", "experience_saved", "no_new_reusable_experience"];
  if (known.includes(reason)) return reason;
  if (reason.includes("budget exceeded")) {
    if (reason.includes("model input/call")) return "model_input_or_call_budget_exhausted";
    if (reason.includes("model call")) return "model_call_budget_exhausted";
    if (reason.includes("model input")) return "model_input_budget_exhausted";
    if (reason.includes("model token")) return "model_token_budget_exhausted";
    if (reason.includes("tool input")) return "tool_input_budget_exhausted";
    if (reason.includes("tool")) return "tool_budget_exhausted";
    return "output_budget_exhausted";
  }
  if (reason === "reflection timed out") return "timeout";
  if (reason === "reflection worker stopped") return "worker_stopped";
  if (reason.includes("lease") || reason.includes("terminal Work/Run")) return "lease_revoked";
  if (status === "skipped") return "pi_reported_no_experience";
  if (!reason) return "unknown";
  return "call_failed";
}

export function recordReflectionAttempt(db: RunnerDatabase, request: MemoryReflection, input: {
  startedAt: string; elapsedMs: number; status: string; reason: string; usage: ReflectionUsage;
}): void {
  const usage = { ...input.usage };
  if (usage.model_calls && !usage.completed_calls) {
    // 已发请求却没有用量回执时，不能把初始化的零冒充实际免费调用。
    usage.input_tokens = usage.output_tokens = usage.cache_read_tokens = usage.cache_write_tokens = usage.cost_usd = null;
    usage.output_bytes = null;
  }
  recordIssueEvent(db, request.issue_id, "issue.memory_reflection_attempt.v1", {
    reflection_id: request.id, issue_run_id: request.run_id.replace(/^xw:run:issue_runs:/, ""),
    attempt: request.attempts, started_at: input.startedAt, elapsed_ms: input.elapsedMs,
    status: input.status, reason_code: reflectionReasonCode(input.reason, input.status),
    usage: { ...usage, completeness: usage.model_calls === null ? "unknown"
      : usage.completed_calls === usage.model_calls ? "reported" : "partial" },
    effectiveness: "not_evaluated"
  });
}
