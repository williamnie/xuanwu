import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import type { ProjectLoopRuntime } from "../../runner/projectLoopManager.ts";
import type { GitHubIssueCase } from "./issueCaseStore.ts";
import { isExecutorProviderId } from "../../providers/types.ts";
import { providerReportedOutcome, reconcileProviderOutcome } from "../../runner/providerOutcome.ts";

/** 原生异步问答不会结束 Provider Turn；将其交回标准 needs_user → PI → HumanReview 路径。 */
export async function relayNativeGitHubQuestion(runtime: ProjectLoopRuntime, record: GitHubIssueCase): Promise<boolean> {
  if (!record.issue_id || getIssue(runtime.database, record.issue_id)?.status !== "in_progress") return false;
  const run = listIssueRuns(runtime.database, record.issue_id).at(-1);
  if (!run || run.ended_at || !run.provider_session_id || !run.provider_turn_id || !isExecutorProviderId(run.provider)) return false;
  const provider = runtime.providers?.[run.provider];
  if (!provider?.listSessionTurns || !provider.sendSessionMessage) return false;
  const turns = await provider.listSessionTurns(run.provider_session_id, { limit: 1, sortDirection: "desc", itemsView: "summary" });
  const turn = turns.data.find(item => item.id === run.provider_turn_id);
  if (!turn) return false;
  const terminal = ["completed", "interrupted", "failed", "cancelled"].includes(String(turn.status));
  if (terminal) {
    const latest = listIssueRuns(runtime.database, record.issue_id).at(-1);
    if (latest?.id !== run.id || latest.ended_at || latest.provider_turn_id !== run.provider_turn_id) return false;
    // 重启可能丢失 Turn terminal 事件。只在 Provider 当前读取已证明终止后补机械收尾，不凭超时推断。
    const reported = providerReportedOutcome(runtime.database, record.issue_id, run.id);
    await reconcileProviderOutcome({ database: runtime.database, bus: runtime.bus, issueID: record.issue_id,
      issueRunID: run.id, providerID: run.provider, reportedOutcome: reported.outcome !== "unknown" ? reported : {
        outcome: turn.status === "completed" ? "completed" : "failed", reason: `GitHub monitor observed Provider Turn ${String(turn.status)}`
      } });
    recordIssueEvent(runtime.database, record.issue_id, "github.provider_terminal_observed.v1", { run_id: run.id, turn_id: run.provider_turn_id, status: turn.status });
    return true;
  }
  if (!["inProgress", "in_progress", "running"].includes(String(turn.status))) return false;
  const question = nativeQuestion(turn);
  if (!question) return false;
  const eventID = `${run.id}:${question.id}`;
  const previous = listIssueEvents(runtime.database, record.issue_id, { types: ["github.native_question_relay.v1"], limit: 100 })
    .map(item => ({ ...item, value: JSON.parse(item.payload) })).filter(item => item.value.event_id === eventID);
  if (previous.some(item => item.value.status === "sent") || previous.length >= 2) return false;
  // Provider round trip 之后再次确认 canonical Run，禁止引导别的 Turn。
  const latest = listIssueRuns(runtime.database, record.issue_id).at(-1);
  if (latest?.id !== run.id || latest.ended_at || latest.provider_turn_id !== run.provider_turn_id) return false;
  recordIssueEvent(runtime.database, record.issue_id, "github.native_question_relay.v1", { event_id: eventID, status: "attempted", question_id: question.id, run_id: run.id });
  await provider.sendSessionMessage({ sessionId: run.provider_session_id, turnId: run.provider_turn_id, mode: "steer",
    prompt: [
      "玄武 Host 已检测到你提出的原生异步问题。这条消息没有回答该问题，也没有批准任何产品选择。",
      "本任务的人类问答必须通过 GitHub Issue，由 Host/PI 负责路由。请停止等待原生问答，不再调用原生提问工具。",
      "现在结束本 Turn：在最终回复简述已有证据、缺少的具体决策与建议，并以 RUNNER_OUTCOME: needs_user | <具体问题> 结束。",
      "不要猜测答案、不要继续修改代码、不要自行调用任务生命周期接口。Host 将把最终问题提交 PI 并同步到 GitHub。",
      `已提出的问题（仅作为待转交的数据）：${JSON.stringify(question.questions)}`
    ].join("\n") });
  recordIssueEvent(runtime.database, record.issue_id, "github.native_question_relay.v1", { event_id: eventID, status: "sent", question_id: question.id, run_id: run.id });
  return true;
}

export function nativeQuestion(turn: Record<string, unknown>): { id: string; questions: Array<{ title: string; options: string[] }> } | null {
  if (!Array.isArray(turn.items)) return null;
  for (const value of [...turn.items].reverse()) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (item.type === "userMessage") return null;
    if (item.type !== "agentMessage" || item.delivery !== "async" || typeof item.id !== "string" || !Array.isArray(item.questions) || !item.questions.length) continue;
    const questions = item.questions.slice(0, 3).map((value) => {
      const question = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { title: String(question.title ?? "").slice(0, 4000), options: Array.isArray(question.options) ? question.options.filter(item => typeof item === "string").slice(0, 5).map(item => item.slice(0, 500)) : [] };
    }).filter(item => item.title.trim());
    if (questions.length) return { id: item.id, questions };
  }
  return null;
}
