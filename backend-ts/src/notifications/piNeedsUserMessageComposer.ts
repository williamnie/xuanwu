import type { AgentSession } from "../db/repositories/agentSessions.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import { redactedUserVisibleText } from "../util/redact.ts";

export type PiNeedsUserMessageInput = {
  diagnosis: string;
  issue: Issue;
  message: string;
  nextStep: string;
  provider: string;
  run?: IssueRun;
  session?: AgentSession | null;
};

const SUMMARY_LIMIT = 180;
const TITLE_LIMIT = 80;

export function composePiNeedsUserMessage(input: PiNeedsUserMessageInput): string {
  const issueTitle = summary(input.issue.title || "未命名任务", TITLE_LIMIT);
  return [
    `我检查了 issue #${input.issue.id}（${issueTitle}）的真实执行状态，确认现在需要你介入。`,
    `当前状态：${runtimeStatus(input)}`,
    `我看到的阻塞点：${blockerSummary(input)}`,
    `我暂时没有继续自动重试：${retryRationale(input.diagnosis)}`,
    `需要你决定：${nextStep(input)}`
  ].join("\n");
}

function runtimeStatus(input: PiNeedsUserMessageInput): string {
  return [
    `issue=${summary(input.issue.status || "unknown", 40)}`,
    runStatus(input.run),
    sessionStatus(input.session),
    input.provider ? `provider=${summary(input.provider, 40)}` : ""
  ].filter(Boolean).join("；");
}

function runStatus(run: IssueRun | undefined): string {
  if (!run) return "没有找到 executor run 记录";
  const ended = run.ended_at === "" ? "未结束" : "已结束";
  return `run=${summary(run.status || "unknown", 40)}，${ended}`;
}

function sessionStatus(session: AgentSession | null | undefined): string {
  if (!session) return "没有可用 executor session";
  const status = summary(session.status || "unknown", 40);
  const updated = summary(session.updated_at || "unknown", 40);
  return `executor session=${status}，最近更新 ${updated}`;
}

function blockerSummary(input: PiNeedsUserMessageInput): string {
  const friendly = friendlyDiagnosis(input.diagnosis);
  const detail = summary(input.message, SUMMARY_LIMIT);
  return detail === "" ? `${friendly}。` : `${friendly}；${detail}`;
}

function nextStep(input: PiNeedsUserMessageInput): string {
  const explicit = summary(input.nextStep, SUMMARY_LIMIT);
  if (explicit !== "") return explicit;
  if (isAuthDiagnosis(input.diagnosis)) return "请确认或刷新 provider 授权/凭证，然后让我重新排队执行。";
  if (hasDiagnosis(input.diagnosis, ["provider_not_registered"])) return "请确认这个项目的 executor provider 配置，再让我重试。";
  if (hasDiagnosis(input.diagnosis, ["todo_without_session"])) return "请确认是否让我重新触发项目 loop，或先检查 provider 启动状态。";
  return "请告诉我是重试、暂停，还是调整需求后继续。";
}

function retryRationale(diagnosis: string): string {
  if (isAuthDiagnosis(diagnosis)) return "重试不会刷新授权状态，只会继续失败并制造更多噪音。";
  if (hasDiagnosis(diagnosis, ["provider_not_registered"])) return "当前没有匹配的执行器，直接重试也启动不了 session。";
  if (hasDiagnosis(diagnosis, ["business_failure", "test_failure", "requires_human_decision"])) {
    return "这更像需求/业务判断点，缺少新的用户决定时继续跑容易变成误报。";
  }
  return "目前没有新的输入能改变失败条件，直接重试可能只是重复同一个错误。";
}

function friendlyDiagnosis(value: string): string {
  if (isAuthDiagnosis(value)) return "provider 授权或账号状态需要确认";
  if (hasDiagnosis(value, ["provider_runtime_unavailable", "runtime_unavailable"])) return "执行环境暂时不可用";
  if (hasDiagnosis(value, ["provider_not_registered"])) return "这个项目当前没有可用的执行器";
  if (hasDiagnosis(value, ["todo_without_session"])) return "issue 没有成功启动 executor session";
  if (hasDiagnosis(value, ["business_failure", "test_failure"])) return "执行结果需要业务或验收判断";
  if (hasDiagnosis(value, ["requires_human_decision", "needs_user"])) return "当前情况需要用户决定下一步";
  return summary(value, 80) || "当前情况需要用户决定下一步";
}

function isAuthDiagnosis(value: string): boolean {
  return hasDiagnosis(value, ["auth", "unauthorized", "permission", "credential", "provider_auth_failed"]);
}

function hasDiagnosis(value: string, needles: string[]): boolean {
  const text = value.toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

function summary(value: unknown, limit: number): string {
  const safe = redactedUserVisibleText(typeof value === "string" ? value : "");
  const runes = [...safe];
  return runes.length <= limit ? safe : `${runes.slice(0, limit - 1).join("")}…`;
}
