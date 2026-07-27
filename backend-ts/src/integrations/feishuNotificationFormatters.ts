import type { Issue } from "../db/repositories/issues.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";

const SUMMARY_LIMIT = 180;
const WATCH_ISSUE_LIMIT = 20;

export function formatIssueStatusNotification(issue: Issue): string {
  const title = safeSummary(issue.title || "任务", 80);
  if (issue.status === "todo") return startText(issue.id, title, "已创建并准备启动 session");
  if (issue.status === "in_progress") return startText(issue.id, title, "已启动 executor session");
  if (issue.status === "done") return doneText(issue, title);
  if (issue.status === "pending_verification") return pendingVerificationText(issue, title);
  return failedText(issue, title);
}

export function formatApprovalNotification(issue: Issue, command: string, path: string): string {
  const detail = [command ? `命令：${safeSummary(command, SUMMARY_LIMIT)}` : "",
    path ? `路径：${safeSummary(path, SUMMARY_LIMIT)}` : ""].filter(Boolean).join("；");
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issue.id} 需要 Codex 授权/确认才能继续。`,
    detail || "授权详情请到 Runner/Codex 面板查看。",
    "可选操作：批准一次 / 本 session 批准 / 拒绝 / 暂缓。",
    "风险：会影响当前 Codex session 的执行授权；页面 Supervisor 控制台仅作为备用入口。"
  ].join("\n");
}

export function formatPiActionPendingNotification(input: {
  actionDetail?: string;
  actionID: string;
  actionType: string;
  issueID?: number;
}): string {
  const issue = input.issueID ? `issue #${input.issueID}` : "当前任务";
  const actionID = safeSummary(input.actionID, 80);
  const actionType = safeSummary(input.actionType || "Supervisor action", 80);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：${issue} 需要用户确认才能继续。`,
    `待确认动作：${actionType}（${actionID}）`,
    input.actionDetail ? `范围：${safeSummary(input.actionDetail, 360)}` : "",
    "下一步：可直接在本 Feishu 卡片批准、拒绝、要求修改或暂缓；Runner issue/后端 API 仍作为备用入口。"
  ].filter(Boolean).join("\n");
}

export function formatPiNeedsUserNotification(input: {
  diagnosis: string;
  issueID?: number;
  message: string;
  nextStep: string;
  provider: string;
  userFacingMessage?: string;
}): string {
  const composed = safeMultiline(input.userFacingMessage, 900);
  if (composed !== "") return composed;
  const issue = input.issueID ? `issue #${input.issueID}` : "当前任务";
  const provider = safeSummary(input.provider || "unknown", 80);
  const diagnosis = safeSummary(input.diagnosis || "needs_user", 100);
  const message = safeSummary(input.message || "Supervisor 判断当前无法继续自动恢复。", SUMMARY_LIMIT);
  const nextStep = safeSummary(input.nextStep || "请查看 Runner issue 并补充授权、凭证或下一步处理方式。", SUMMARY_LIMIT);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：${issue} 需要用户介入。`,
    `Provider：${provider}`,
    `诊断：${diagnosis}`,
    `摘要：${message}`,
    `下一步：${nextStep}`
  ].join("\n");
}

export function formatIssueCompletionWatchNotification(payload: Record<string, unknown>): string {
  const stats = record(payload.stats);
  const issues = watchIssues(payload.issues);
  const total = numberField(stats.total) || issues.length;
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：你关注的 ${total} 个 issue 已结束`,
    watchStatsLine(stats),
    "列表：",
    ...watchIssueLines(issues),
    `下一步：${watchNextStep(stats)}`
  ].join("\n");
}

function startText(issueID: number, title: string, status: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issueID} ${status}：${title}`,
    "状态：我会在需要授权、完成、失败或阻塞时继续通知。"
  ].join("\n");
}

function doneText(issue: Issue, title: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issue.id} 已完成：${title}`,
    `验证状态：${issue.error ? safeSummary(issue.error, SUMMARY_LIMIT) : "已标记完成，未附加验证摘要。"}`
  ].join("\n");
}

function pendingVerificationText(issue: Issue, title: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issue.id} 已进入待验收：${title}`,
    `验证状态：${issue.error ? safeSummary(issue.error, SUMMARY_LIMIT) : "等待用户验收。"}`
  ].join("\n");
}

function failedText(issue: Issue, title: string): string {
  const error = safeSummary(issue.error || "未提供错误摘要", SUMMARY_LIMIT);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：issue #${issue.id} 执行失败/阻塞：${title}`,
    `错误摘要：${error}`,
    `下一步：请查看 Runner issue #${issue.id} 的日志，补充授权/信息后 retry 或重新排队。`
  ].join("\n");
}

function watchStatsLine(stats: Record<string, unknown>): string {
  return [
    `done：${numberField(stats.done)}`,
    `failed：${numberField(stats.failed)}`,
    `cancelled：${numberField(stats.cancelled)}`,
    `pending_verification：${numberField(stats.pending_verification)}`
  ].join(" / ");
}

function watchIssueLines(issues: Array<Record<string, unknown>>): string[] {
  if (issues.length === 0) return ["- （无 issue 明细）"];
  return issues.slice(0, WATCH_ISSUE_LIMIT).map((issue) => {
    const id = numberField(issue.id);
    const title = safeSummary(textField(issue.title) || "未命名 issue", 80);
    const status = safeSummary(textField(issue.status) || "unknown", 40);
    return `- #${id} ${title} — ${status}`;
  });
}

function watchNextStep(stats: Record<string, unknown>): string {
  if (numberField(stats.failed) + numberField(stats.cancelled) > 0) {
    return "存在 failed/cancelled，请先处理失败或取消项，再决定是否继续测试。";
  }
  return "全部 done/pending_verification，可以开始测试。";
}

function safeSummary(value: unknown, maxRunes: number): string {
  const safe = redactedUserVisibleText(cleanString(value));
  const runes = [...safe];
  return runes.length <= maxRunes ? safe : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function safeMultiline(value: unknown, maxRunes: number): string {
  const lines = cleanString(value).split(/\r?\n/)
    .map((line) => redactedUserVisibleText(line))
    .filter(Boolean);
  const safe = lines.join("\n");
  const runes = [...safe];
  return runes.length <= maxRunes ? safe : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function watchIssues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item) => numberField(item.id) > 0) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
