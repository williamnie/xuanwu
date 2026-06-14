import type { Issue } from "../db/repositories/issues.ts";
import type { PiMemoryItem } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "../pi/memoryPolicy.ts";
import { redactSensitiveText } from "../util/redact.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const STACK_LINE_PATTERN = /^\s*at\s+\S+/;
const SUMMARY_LIMIT = 180;

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
    `Pi：issue #${issue.id} 需要 Codex 授权/确认才能继续。`,
    detail || "授权详情请到 Runner/Codex 面板查看。",
    "可选操作：批准一次 / 本 session 批准 / 拒绝 / 暂缓。",
    "风险：会影响当前 Codex session 的执行授权；页面 PI 控制台仅作为备用入口。"
  ].join("\n");
}

export function formatMemoryCandidateNotification(item: PiMemoryItem): string {
  const id = shortID(item.id);
  return [
    `Pi：memory candidate 待确认：${id}`,
    `- [${safeSummary(item.scope, 24)} | ${safeSummary(item.kind, 40)}] ${memoryContent(item)}`,
    `操作：发送 /memory approve ${id} 确认，或 /memory reject ${id} 删除。`
  ].join("\n");
}

export function formatPiActionPendingNotification(input: { actionID: string; actionType: string; issueID?: number }): string {
  const issue = input.issueID ? `issue #${input.issueID}` : "当前任务";
  const actionID = safeSummary(input.actionID, 80);
  const actionType = safeSummary(input.actionType || "PI action", 80);
  return [
    `Pi：${issue} 需要用户确认才能继续。`,
    `待确认动作：${actionType}（${actionID}）`,
    "下一步：请在 Runner issue/PI 审批入口确认、拒绝或要求修改。"
  ].join("\n");
}

function startText(issueID: number, title: string, status: string): string {
  return [
    `Pi：issue #${issueID} ${status}：${title}`,
    "状态：我会在需要授权、完成、失败或阻塞时继续通知。"
  ].join("\n");
}

function doneText(issue: Issue, title: string): string {
  return [
    `Pi：issue #${issue.id} 已完成：${title}`,
    `验证状态：${issue.error ? safeSummary(issue.error, SUMMARY_LIMIT) : "已标记完成，未附加验证摘要。"}`
  ].join("\n");
}

function pendingVerificationText(issue: Issue, title: string): string {
  return [
    `Pi：issue #${issue.id} 已进入待验收：${title}`,
    `验证状态：${issue.error ? safeSummary(issue.error, SUMMARY_LIMIT) : "等待用户验收。"}`
  ].join("\n");
}

function failedText(issue: Issue, title: string): string {
  const error = safeSummary(issue.error || "未提供错误摘要", SUMMARY_LIMIT);
  return [
    `Pi：issue #${issue.id} 执行失败/阻塞：${title}`,
    `错误摘要：${error}`,
    `下一步：请查看 Runner issue #${issue.id} 的日志，补充授权/信息后 retry 或重新排队。`
  ].join("\n");
}

function memoryContent(item: PiMemoryItem): string {
  if (containsSensitiveMemoryContent(item.content)) return "内容包含敏感信息（已隐藏）";
  return safeSummary(item.content, 90);
}

function safeSummary(value: unknown, maxRunes: number): string {
  const safe = redactSensitiveText(cleanString(value))
    .split(/\r?\n/)
    .filter((line) => !STACK_LINE_PATTERN.test(line))
    .join(" ")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
  const runes = [...safe];
  return runes.length <= maxRunes ? safe : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function shortID(id: string): string {
  return id.slice(0, 8);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
