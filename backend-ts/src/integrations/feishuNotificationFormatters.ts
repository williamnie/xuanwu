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
  if (issue.status === "needs_user") return needsUserText(issue, title);
  return failedText(issue, title);
}

export function formatApprovalNotification(issue: Issue, command: string, path: string): string {
  const detail = [command ? `命令：${safeSummary(command, SUMMARY_LIMIT)}` : "",
    path ? `路径：${safeSummary(path, SUMMARY_LIMIT)}` : ""].filter(Boolean).join("；");
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：#${issue.id}「${safeSummary(issue.title || "任务", 80)}」需要你确认后才能继续。`,
    detail || "具体操作可以在 Runner/Codex 面板查看。",
    "你可以回复：批准一次 / 本次执行都批准 / 拒绝 / 暂缓。",
    "这次选择只影响当前执行授权。"
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
    `${SUPERVISOR_NOTIFICATION_PREFIX}：${issue} 有一项操作需要你确认。`,
    `操作是 ${actionType}（${actionID}）。`,
    input.actionDetail ? `涉及范围：${safeSummary(input.actionDetail, 360)}` : "",
    "你可以直接批准、拒绝、要求修改或暂缓。"
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
    `${SUPERVISOR_NOTIFICATION_PREFIX}：${issue} 现在需要你处理。`,
    `我看到的问题是：${message}（${diagnosis}，执行器 ${provider}）。`,
    `请你：${nextStep}`
  ].join("\n");
}

export function formatIssueCompletionWatchNotification(payload: Record<string, unknown>): string {
  const stats = record(payload.stats);
  const issues = watchIssues(payload.issues);
  const total = numberField(stats.total) || issues.length;
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：你关注的 ${total} 个任务都结束了。`,
    watchStatsLine(stats),
    "结果如下：",
    ...watchIssueLines(issues),
    watchNextStep(stats)
  ].join("\n");
}

function startText(issueID: number, title: string, status: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：#${issueID}「${title}」${status}。`,
    "有结果或需要你时，我再告诉你。"
  ].join("\n");
}

function doneText(issue: Issue, title: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：#${issue.id}「${title}」已结束。`,
    issue.error
      ? `可核对的验证结果：${safeSummary(issue.error, SUMMARY_LIMIT)}`
      : "任务已结束，但这次通知里没有可核对的验证结果。"
  ].join("\n");
}

function needsUserText(issue: Issue, title: string): string {
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：#${issue.id}「${title}」需要你处理。`,
    issue.error ? `原因是：${safeSummary(issue.error, SUMMARY_LIMIT)}` : "请查看具体问题并选择下一步。"
  ].join("\n");
}

function failedText(issue: Issue, title: string): string {
  const error = safeSummary(issue.error || "未提供错误摘要", SUMMARY_LIMIT);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：#${issue.id}「${title}」没有完成。`,
    `原因是：${error}`,
    `请查看 #${issue.id} 的执行记录；补齐授权或信息后再重试。`
  ].join("\n");
}

function watchStatsLine(stats: Record<string, unknown>): string {
  return [
    `完成 ${numberField(stats.done)}`,
    `失败 ${numberField(stats.failed)}`,
    `取消 ${numberField(stats.cancelled)}`,
    `需要你处理 ${numberField(stats.needs_user)}`
  ].join("，");
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
    return "有任务失败或取消，请先查看这些任务，再决定是否继续。";
  }
  return "这些任务都已经结束，可以开始下一阶段。";
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
