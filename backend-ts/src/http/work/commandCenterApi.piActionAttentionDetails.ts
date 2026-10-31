import type { RunnerDatabase } from "../../db/database.ts";
import { type PiAction } from "../../db/repositories/pi.ts";
import type { AttentionRecord } from "../../domain/attention/contracts.ts";
import type { WorkStatus } from "../../domain/work/contracts.ts";
import { cleanString } from "../../util/values.ts";

export const COMMAND_CENTER_SUMMARY_CONTRACT = "xw.command-center.summary.v1" as const;

export const COMMAND_CENTER_COMPATIBILITY_POLICY = {
  attention_command_audit_authority: "attention_command_events-append-only-overlay",
  attention_read_authority: "authoritative-attention-approval-and-pi-action-adapters-with-command-overlay",
  dual_read: "none-request-time-projection-over-current-authorities",
  dual_write: "none-legacy-facts-remain-single-writer",
  final_removal_gate: "P11.03/P11.09-and-G7-and-one-release-zero-legacy-mutation-consumers-with-backup-restore",
  handoff_read_authority: "issue_events:handoff.*.v1",
  rollback: "unregister-command-center-route-and-restore-bounded-legacy-Dashboard-reads-without-data-migration",
  run_read_authority: "issue_runs+run_attempts+issue_events-read-through-progress",
  readiness_read_authority: "issues.status+work_relations+issue_events:evidence.recorded.v1-request-time-projection",
  work_read_authority: "issues-via-Work-adapter"
} as const;

export const COMMAND_CENTER_SECTIONS = [
  "attention",
  "active_work",
  "recent_deliveries",
  "system_health"
] as const;

export const DEFAULT_LIMIT = 10;

export const MAX_LIMIT = 25;

export const SUMMARY_TEXT_LIMIT = 320;

export const ACTIVE_WORK_STATUSES: WorkStatus[] = ["todo", "in_progress", "needs_user"];

export const RECENT_HANDOFF_STATUSES = ["draft", "ready", "delivered"];

export function attentionIsVisible(item: AttentionRecord, now: Date): boolean {
  if (item.status !== "open" && item.status !== "waiting") return false;
  if (!item.snoozed_until) return true;
  const until = Date.parse(item.snoozed_until);
  return !Number.isFinite(until) || until <= now.getTime();
}

export function piActionAttentionDetails(
  db: RunnerDatabase,
  action: PiAction,
  item: AttentionRecord,
  now: Date
): Record<string, unknown> {
  const target = piActionTarget(db, action);
  const notification = piActionNotificationStatus(db, action.id);
  const location = [
    action.project_id ? `项目 ${action.project_id}` : "Runner 系统",
    target.issueID > 0 ? `Issue #${target.issueID}` : "",
    action.action_type ? `动作 ${action.action_type}` : ""
  ].filter(Boolean).join(" · ");
  if (piActionIsHistorical(action, target.issueStatus)) {
    return {
      active: false,
      component: "Action Gate",
      description: `原操作目标已经进入 ${target.issueStatus || "终态"}，这条旧请求不再需要执行。`,
      diagnostic: item.summary,
      first_seen_at: item.created_at,
      handling: "historical",
      historical: true,
      last_seen_at: target.updatedAt || item.updated_at,
      location,
      pi_action: "PI 已根据当前 Issue 状态把它从用户待办中移出；原审计记录继续保留。",
      pi_can_handle: false,
      requires_user: false,
      state_label: "历史记录 · 目标已结束",
      title: "旧操作请求已失效",
      user_action: "当前无需操作。",
      source: "pi_actions"
    };
  }
  const snoozedUntil = Date.parse(action.snoozed_until);
  const piWaiting = action.status === "snoozed" && (
    (Number.isFinite(snoozedUntil) && snoozedUntil > now.getTime()) ||
    action.gate_reason === "recovery cooldown has not elapsed"
  );
  if (piWaiting) {
    return {
      active: true,
      component: "PI 恢复调度器",
      description: "恢复动作处于确定性冷却窗口，PI 会在窗口到期后重新评估。",
      diagnostic: item.summary,
      first_seen_at: item.created_at,
      handling: "pi_handling",
      historical: false,
      last_seen_at: item.updated_at,
      location,
      pi_action: "PI 正在等待恢复冷却窗口，期间不会重复启动会话或打扰你。",
      pi_can_handle: true,
      requires_user: false,
      state_label: "当前事项 · PI 等待后重试",
      title: "PI 已延后恢复动作",
      user_action: "当前无需操作。",
      source: "pi_actions"
    };
  }
  return {
    active: true,
    component: "Action Gate",
    description: notification.delivery === "sent"
      ? `PI 请求执行 ${action.action_type}，审批已经推送到飞书；页面仅保留兜底入口。`
      : notification.delivery === "failed"
        ? `PI 请求执行 ${action.action_type}，但飞书审批通知未送达；请在页面处理或修复通知目标。`
        : `PI 请求执行 ${action.action_type}，该动作需要你的明确决定。`,
    diagnostic: item.summary,
    first_seen_at: item.created_at,
    handling: "user_action_required",
    historical: false,
    last_seen_at: item.updated_at,
    location,
    notification,
    pi_action: `PI 已在 Action Gate 停止执行；原因：${action.gate_reason || "等待人工决定"}。`,
    pi_can_handle: false,
    requires_user: true,
    state_label: notification.delivery === "sent"
      ? "已推送飞书 · 页面兜底"
      : notification.delivery === "failed" ? "飞书未送达 · 页面兜底" : "当前事项 · 需要你决定",
    title: `是否允许 ${action.action_type}`,
    user_action: "审阅动作范围、目标和风险，然后批准、拒绝或要求修改。",
    source: "pi_actions"
  };
}

export function piActionNotificationStatus(
  db: RunnerDatabase,
  actionID: string
): { delivery: "failed" | "missing" | "queued" | "sent"; error: string; state: string } {
  const row = db.sqlite.query<{
    error: string; outbox_error: string | null; outbox_status: string | null;
    sent_outbox_id: number; state: string;
  }, [string]>(`
    select intent.state, intent.error, intent.sent_outbox_id,
      outbox.status as outbox_status, outbox.last_error as outbox_error
    from pi_notification_intents intent
    left join sync_outbox outbox on outbox.id=intent.sent_outbox_id
    where intent.kind='pi_action_pending' and intent.source_event_id=?
    order by intent.created_at desc, intent.id desc limit 1
  `).get(actionID);
  if (!row) return { delivery: "missing", error: "notification_intent_missing", state: "missing" };
  if (row.state === "sent" && row.outbox_status === "sent") {
    return { delivery: "sent", error: "", state: row.state };
  }
  if (row.state === "failed" || row.outbox_status === "failed" || row.error !== "") {
    return { delivery: "failed", error: cleanString(row.outbox_error) || row.error, state: row.state };
  }
  return { delivery: "queued", error: "", state: row.state };
}

export function piActionTarget(
  db: RunnerDatabase,
  action: PiAction
): { issueID: number; issueStatus: string; updatedAt: string } {
  const payload = safeRecord(action.payload_json);
  let issueID = positiveID(action.issue_id) || positiveID(payload.issue_id);
  if (issueID <= 0) {
    const providerSessionID = cleanString(payload.provider_session_id);
    const session = providerSessionID ? db.sqlite.query<{ issue_id: number }, [string]>(`
      select issue_id from agent_sessions where provider_session_id=? order by updated_at desc limit 1
    `).get(providerSessionID) : null;
    issueID = positiveID(session?.issue_id);
  }
  if (issueID <= 0) return { issueID: 0, issueStatus: "", updatedAt: "" };
  const issue = db.sqlite.query<{ status: string; updated_at: string }, [number]>(
    "select status, updated_at from issues where id=?"
  ).get(issueID);
  return { issueID, issueStatus: cleanString(issue?.status), updatedAt: cleanString(issue?.updated_at) };
}

export function piActionIsHistorical(action: PiAction, issueStatus: string): boolean {
  if (!new Set(["done", "cancelled"]).has(issueStatus)) return false;
  return new Set([
    "issue.retry", "issue.retry_after", "issue.state_repair",
    "session.resume_followup", "session.steer"
  ]).has(action.action_type);
}

export function safeRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function positiveID(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
