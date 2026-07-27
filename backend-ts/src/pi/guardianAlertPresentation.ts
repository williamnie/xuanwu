import type { PiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";

export type GuardianAlertHandling = "historical" | "pi_handling" | "user_action_required";

export type GuardianAlertPresentation = {
  active: boolean;
  component: string;
  description: string;
  first_seen_at: string;
  handling: GuardianAlertHandling;
  historical: boolean;
  last_seen_at: string;
  location: string;
  pi_action: string;
  pi_can_handle: boolean;
  requires_user: boolean;
  state_label: string;
  title: string;
  user_action: string;
};

type AlertCopy = {
  component: string;
  description: string;
  piAction: string;
  title: string;
  userAction: string;
  userOwned?: boolean;
};

const AUTO_ESCALATE_AFTER_MS = 30 * 60_000;
const MEMORY_ESCALATE_AFTER_MS = 15 * 60_000;

const ALERT_COPY: Record<string, AlertCopy> = {
  automation_dead_letter: {
    component: "Automation 调度器",
    description: "自动任务已耗尽重试次数并进入 dead letter，PI 已停止继续执行以避免重复副作用。",
    piAction: "PI 已保留最后一次失败事实、尝试次数和 Automation 运行记录。",
    title: "Automation 自动恢复未成功",
    userAction: "打开对应 Automation，修正输入、连接或执行器后再手动重试。",
    userOwned: true
  },
  approval_fast_path_error: {
    component: "审批解析器",
    description: "审批请求未能自动完成解析或回写，相关操作仍保持在安全门禁内。",
    piAction: "PI 会保留请求并停止重复执行，等待人工确认。",
    title: "审批处理需要人工确认",
    userAction: "打开审批详情，确认请求内容后批准、拒绝或修正连接配置。",
    userOwned: true
  },
  coordinator_stalled: {
    component: "通知协调器",
    description: "部分通知意图超过处理时限，消息可能延迟，但不会丢失业务状态。",
    piAction: "PI 会继续调度通知并在队列恢复后自动归档该告警。",
    title: "通知协调器出现积压",
    userAction: "若持续超过 30 分钟，请检查通知目标和飞书连接。"
  },
  digest_flush_stalled: {
    component: "日报与摘要调度器",
    description: "摘要发送超过预期时间，日报或阶段摘要可能延迟。",
    piAction: "PI 会重试摘要生成和发送，恢复后自动补发并归档。",
    title: "摘要发送延迟",
    userAction: "若持续超过 30 分钟，请检查摘要目标和飞书连接。"
  },
  guardian_inbox_stalled: {
    component: "Guardian 事件收件箱",
    description: "Guardian 事件等待消费，自动诊断和恢复动作可能延迟。",
    piAction: "PI 会继续消费积压事件并在恢复后自动归档。",
    title: "Guardian 事件处理延迟",
    userAction: "若持续超过 30 分钟，请检查 Core scheduler 是否仍在运行。"
  },
  handoff_tracker_update_failed: {
    component: "Handoff Tracker 同步",
    description: "Handoff 的外部 Tracker 更新已耗尽重试次数；本地 Handoff 事实没有丢失。",
    piAction: "PI 已停止重复外部写入，并保留 outbox、授权和失败证据供复核。",
    title: "Handoff 外部状态同步失败",
    userAction: "打开对应 Handoff，检查 Tracker 连接和目标状态；恢复后重新发起同步。",
    userOwned: true
  },
  issue_watchdog_runnable_without_runtime: {
    component: "Issue 会话看守",
    description: "Issue 已具备继续执行条件，但 PI 在恢复预算内仍未能启动或恢复运行会话。",
    piAction: "PI 已完成有界重试并停止重复启动，避免产生更多失败会话。",
    title: "Issue 会话自动恢复未成功",
    userAction: "打开对应 Issue，检查 Runner、Provider 或项目运行配置；恢复后 PI 会自动归档。",
    userOwned: true
  },
  missed_digest_pending: {
    component: "通知恢复摘要",
    description: "通知链路中断期间有消息需要汇总补发。",
    piAction: "PI 会在通知链路恢复后自动生成一条恢复摘要，避免逐条打扰。",
    title: "PI 正在补发恢复摘要",
    userAction: "当前无需操作；若提示缺少通知目标，请在连接设置中补充目标。"
  },
  outbox_stalled: {
    component: "通知发送队列",
    description: "通知已经进入发送队列，但尚未取得外部平台的发送回执。",
    piAction: "PI 会保留幂等键并自动重试，恢复后只发送一次。",
    title: "通知发送暂时延迟",
    userAction: "若持续超过 30 分钟，请检查飞书连接、通知目标和网络状态。"
  },
  pi_runtime_down: {
    component: "项目 PI Runtime",
    description: "项目的 PI Agent、会话或运行配置不可用，自动处理可能已暂停。",
    piAction: "PI 会尝试恢复可恢复的会话；缺失或禁用 Agent 时不会自行修改配置。",
    title: "项目 PI Runtime 不可用",
    userAction: "检查项目的 PI Agent 是否存在并启用；必要时重新启动对应会话。",
    userOwned: true
  },
  runner_process_group_memory_budget: {
    component: "Runner 内存监控",
    description: "Runner Core 与已登记 Provider 子进程的权威内存测量连续超过当前活动阶段预算。",
    piAction: "PI 会持续使用非挂起采样复核；恢复到预算内后自动归档，同一事件只保留一个可升级告警。",
    title: "Runner 内存超过预算",
    userAction: "若连续 15 分钟未恢复，请在系统状态核对测量来源、权威值与占用最高的进程；确认没有活跃运行后再重启 Runner。"
  },
  scheduler_stalled: {
    component: "Supervisor 调度器",
    description: "自动巡检心跳已超时，PI 可能无法继续执行自愈动作。",
    piAction: "PI 会在后续巡检中确认调度器是否恢复；短暂心跳延迟只保留为运行记录。",
    title: "Supervisor 调度器已停止响应",
    userAction: "若持续超过 30 分钟，请检查 Core 服务和 scheduler 进程，恢复服务后刷新状态。"
  }
};

export function guardianAlertPresentation(
  alert: PiGuardianAlert,
  now: Date = new Date()
): GuardianAlertPresentation {
  const copy = ALERT_COPY[alert.alert_type] ?? fallbackCopy(alert.alert_type);
  const historical = alert.status === "resolved" || alert.status === "suppressed";
  const active = !historical;
  const requiresUser = active && requiresUserAction(alert, copy, now);
  const handling: GuardianAlertHandling = historical
    ? "historical"
    : requiresUser
      ? "user_action_required"
      : "pi_handling";
  return {
    active,
    component: copy.component,
    description: copy.description,
    first_seen_at: alert.created_at,
    handling,
    historical,
    last_seen_at: alert.watchdog_seen_at || alert.updated_at,
    location: alertLocation(alert),
    pi_action: copy.piAction,
    pi_can_handle: active && !requiresUser && !copy.userOwned,
    requires_user: requiresUser,
    state_label: stateLabel(alert, handling),
    title: copy.title,
    user_action: requiresUser ? copy.userAction : "当前无需操作；PI 会在需要你介入时单独升级提醒。"
  };
}

function requiresUserAction(alert: PiGuardianAlert, copy: AlertCopy, now: Date): boolean {
  if (alert.status === "acked") return false;
  if (copy.userOwned) return true;
  if (alert.max_retry_count > 0 && alert.retry_count >= alert.max_retry_count) return true;
  const age = Math.max(0, now.getTime() - Date.parse(alert.created_at));
  if (alert.alert_type === "runner_process_group_memory_budget") return age >= MEMORY_ESCALATE_AFTER_MS;
  return age >= AUTO_ESCALATE_AFTER_MS && !alwaysPiOwned(alert.alert_type);
}

function alwaysPiOwned(alertType: string): boolean {
  return alertType === "missed_digest_pending";
}

function alertLocation(alert: PiGuardianAlert): string {
  const values = [
    alert.project_id ? `项目 ${alert.project_id}` : "Runner 系统",
    alert.issue_id > 0 ? `Issue #${alert.issue_id}` : "",
    alert.run_group_id ? `运行组 ${alert.run_group_id}` : ""
  ].filter(Boolean);
  return values.join(" · ");
}

function stateLabel(alert: PiGuardianAlert, handling: GuardianAlertHandling): string {
  if (handling === "historical") return alert.status === "suppressed" ? "历史记录 · 已忽略" : "历史记录 · 已恢复";
  if (alert.status === "acked") return "已知晓 · 等待来源恢复";
  if (handling === "user_action_required") return "当前故障 · 需要你处理";
  return "当前故障 · PI 自动处理中";
}

function fallbackCopy(alertType: string): AlertCopy {
  const connection = /connect|provider|auth|unavailable/i.test(alertType);
  return {
    component: connection ? "外部连接" : "Guardian Runtime",
    description: connection
      ? "外部服务或 Provider 当前不可用，相关自动任务可能延迟。"
      : "Guardian 检测到运行异常，相关任务可能延迟。",
    piAction: "PI 会在安全预算内重试并持续核对运行状态。",
    title: connection ? "外部连接暂时不可用" : "PI 检测到运行异常",
    userAction: "检查对应项目、连接和运行日志；确认恢复后等待告警自动归档。",
    userOwned: connection
  };
}
