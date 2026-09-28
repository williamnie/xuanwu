import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getProject } from "../db/repositories/projects.ts";
import { normalizeCodexEvent } from "../providers/codex/events.ts";
import type { ExecutorProvider } from "../providers/types.ts";
import type { EventBus } from "../events/bus.ts";
import { persistRecoveredProviderEvents } from "./providerRuntime.ts";

export type ProviderTurnObservation = "unsupported" | "unavailable" | "changed" | "active" | "interrupted" | "reconciled";

/** 恢复前读取当前回合的原始事实；不发送消息、不把完成声明直接当作 Issue 验收。 */
export async function reconcileCurrentProviderTurn(input: {
  database: RunnerDatabase;
  issueID: number;
  provider?: ExecutorProvider;
  bus?: Pick<EventBus, "publish">;
}): Promise<ProviderTurnObservation> {
  const { database: db, issueID, provider } = input;
  // Codex 提供有界的原生回合页；其他适配器仍由其已接入的运行事件处理。
  if (provider?.id !== "codex" || !provider.listSessionTurns) return "unsupported";
  const issue = getIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  // 已终结或尚未取得 Session 的故障仍沿原有 PI 决策处理，不被本补采路径吞掉。
  if (!issue || !run || issue.status !== "in_progress" || run.ended_at !== "" ||
    !run.provider_session_id || !run.provider_turn_id) return "unsupported";
  if (run.provider !== provider.id) return "changed";
  const project = getProject(db, issue.project_id);
  if (!project) return "unavailable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turn: Record<string, unknown> | undefined;
  try {
    const page = await Promise.race([
      provider.listSessionTurns(run.provider_session_id, { limit: 1, sortDirection: "desc", itemsView: "full" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Provider turn read timeout")), 5_000); })
    ]);
    turn = page.data[0];
  } catch {
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
  // await 期间可能有人重试或取消；旧结果不得写入新 Run/Turn。
  const latest = listIssueRuns(db, issueID).at(-1);
  if (getIssue(db, issueID)?.status !== "in_progress" || latest?.id !== run.id || latest.ended_at !== "" ||
    latest.provider_turn_id !== run.provider_turn_id || latest.provider_session_id !== run.provider_session_id) return "changed";
  if (!turn) return "unavailable";
  if (turn.id !== run.provider_turn_id) return "changed";
  const status = String(turn.status ?? "").toLowerCase();
  if (["inprogress", "running", "waiting"].includes(status)) return "active";
  if (["interrupted", "cancelled", "canceled"].includes(status)) return "interrupted";
  if (!["completed", "failed"].includes(status) || !Array.isArray(turn.items)) return "unavailable";
  const params = { threadId: run.provider_session_id, turnId: run.provider_turn_id };
  const events = turn.items.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
    ["agentMessage", "commandExecution", "dynamicToolCall", "fileChange"].includes(item.type)
  ).map((item) => normalizeCodexEvent({ method: "item/completed", params: { ...params, item } }));
  events.push(normalizeCodexEvent({ method: "turn/completed", params: { ...params, turn } }));
  await persistRecoveredProviderEvents({
    database: db, bus: input.bus, issueId: issueID, issueRunId: run.id,
    projectId: issue.project_id, cwd: project.cwd, prompt: ""
  }, events);
  recordIssueEvent(db, issueID, "issue.provider_session_reconciled.v1", {
    issue_run_id: run.id, provider: provider.id, provider_session_id: run.provider_session_id,
    provider_turn_id: run.provider_turn_id, status, source: "thread/turns/list"
  });
  return "reconciled";
}
