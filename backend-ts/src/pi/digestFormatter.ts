import type { PiNotificationIntent } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";

type DigestIssue = { bucket: string; issueID: number; reason: string; status: string; title: string };
type DigestView = {
  active: number; completed: number; failed: number; needsUser: number;
  issues: DigestIssue[]; runGroupID: string; skipped: number; total: number; verification: number;
};

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const STACK_LINE_PATTERN = /^\s*at\s+\S+/;
const SUMMARY_LIMIT = 140;

export function formatRunGroupDigest(intent: PiNotificationIntent): string {
  const view = digestView(intent);
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：运行组 ${safeSummary(view.runGroupID || intent.run_group_id || "digest", 80)} 摘要`,
    `原因：${safeSummary(intent.flush_reason || "digest", 40)}；批次：${intent.flush_sequence || intent.flush_bucket || "-"}`,
    [
      `总数：${view.total}`,
      `完成：${view.completed}`,
      `待验证：${view.verification}`,
      `失败：${view.failed}`,
      `需要用户：${view.needsUser}`,
      `仍在跑：${view.active}`,
      `跳过：${view.skipped}`
    ].join(" / "),
    ...issueSections(view.issues),
    nextStep(view)
  ].filter(Boolean).join("\n");
}

function digestView(intent: PiNotificationIntent): DigestView {
  const payload = parsePayload(intent.payload_json);
  return {
    active: count(payload, "active_count", "active"),
    completed: count(payload, "completed_count", "completed"),
    failed: count(payload, "failed_count", "failed"),
    issues: issueList(payload.issues),
    needsUser: count(payload, "needs_user_count", "needsUser"),
    runGroupID: text(payload.run_group_id) || intent.run_group_id,
    skipped: count(payload, "skipped_count", "skipped"),
    total: count(payload, "total_count", "total"),
    verification: count(payload, "verification_count", "verification")
  };
}

function issueSections(issues: DigestIssue[]): string[] {
  const important = issues.filter((issue) => ["failed", "needs_user"].includes(issue.bucket));
  const enqueue = issues.filter((issue) => isEnqueueStatus(issue.status));
  return [
    section("失败/需要用户", important),
    section("入队/跳过", enqueue)
  ].filter(Boolean);
}

function section(title: string, issues: DigestIssue[]): string {
  const lines = uniqueIssues(issues).slice(0, 8).map(issueLine);
  return lines.length === 0 ? "" : [`${title}：`, ...lines].join("\n");
}

function issueLine(issue: DigestIssue): string {
  const status = safeSummary(issue.status || issue.bucket || "unknown", 40);
  const reason = safeSummary(issue.reason || "未提供原因", SUMMARY_LIMIT);
  return `- issue #${issue.issueID} ${status}：${reason}`;
}

function nextStep(view: DigestView): string {
  if (view.needsUser > 0) return "下一步：有任务需要用户处理，请查看对应 issue 后继续。";
  if (view.failed > 0) return "下一步：有任务失败/阻塞，请查看对应 issue 日志后 retry 或重新排队。";
  if (view.active > 0) return "下一步：仍有任务在跑，我会继续等待并在后续摘要更新。";
  return "下一步：本批次已完成或无需继续处理。";
}

function uniqueIssues(issues: DigestIssue[]): DigestIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.issueID}:${issue.status}:${issue.bucket}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issueList(value: unknown): DigestIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map(issueView).filter((issue) => issue.issueID > 0);
}

function issueView(value: unknown): DigestIssue {
  const row = objectValue(value);
  return {
    bucket: text(row.bucket),
    issueID: positiveNumber(row.issue_id),
    reason: text(row.reason),
    status: text(row.status),
    title: text(row.title)
  };
}

function isEnqueueStatus(status: string): boolean {
  return ["enqueue_failed", "enqueue_pending_approval", "skipped"].includes(status);
}

function count(payload: Record<string, unknown>, primary: string, legacy: string): number {
  return positiveNumber(payload[primary]) || positiveNumber(payload[legacy]);
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeSummary(value: unknown, maxRunes: number): string {
  const safe = redactSensitiveText(text(value))
    .split(/\r?\n/)
    .filter((line) => !STACK_LINE_PATTERN.test(line))
    .join(" ")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
  const runes = [...safe];
  return runes.length <= maxRunes ? safe : `${runes.slice(0, maxRunes - 1).join("")}…`;
}
