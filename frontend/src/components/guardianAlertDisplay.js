const ALERT_TYPE_DISPLAYS = {
  coordinator_stalled: {
    message: '通知协调器存在待处理任务，后续通知分发可能延迟。请检查 Guardian 的 coordinator 状态和 pending intents。',
    title: '通知协调器处理停滞',
  },
  digest_flush_stalled: {
    message: '摘要发送已超过预期，可能导致飞书摘要延迟。请检查 Guardian 的 digest 状态和相关 run group；恢复后系统会继续发送。',
    title: '飞书摘要发送积压',
  },
  guardian_inbox_stalled: {
    message: 'Guardian 事件仍在等待处理，告警和通知恢复可能延迟。请检查 inbox consumer 与事件处理循环。',
    title: 'Guardian 事件收件箱积压',
  },
  missed_digest_pending: {
    message: missedDigestPendingMessage,
    title: '飞书摘要通知暂时不可用',
  },
  outbox_stalled: {
    message: '有通知停留在发送队列，可能导致飞书消息延迟。请检查 outbox、飞书配置与网络状态；确认后可等待自动重试。',
    title: '飞书通知发送队列积压',
  },
  scheduler_stalled: {
    message: 'Supervisor 自动调度心跳已超时，自动巡检和恢复可能暂停。请确认 scheduler 进程仍在运行，必要时重启 Runner 服务。',
    title: 'Supervisor 自动调度心跳停滞',
  },
};

const REASON_LABELS = {
  digest_pipeline_unavailable: '通知摘要链路不可用',
  missing_digest_target: '缺少摘要通知目标',
  missing_feishu_target: '缺少飞书通知目标',
};

const SEVERITY_LABELS = {
  urgent: '紧急',
  watch: '观察',
};

export function buildGuardianAlertDisplay(alert = {}) {
  const severityLabel = guardianSeverityLabel(alert.severity);
  const display = ALERT_TYPE_DISPLAYS[alert.alert_type] ?? fallbackDisplay();
  return {
    message: alertMessage(display, alert),
    meta: alertMeta(alert, severityLabel),
    severityLabel,
    title: display.title,
  };
}

export function guardianReasonLabel(reason) {
  const key = cleanText(reason);
  if (key === '') return '';
  if (REASON_LABELS[key]) return REASON_LABELS[key];
  return '通知链路异常';
}

export function guardianSeverityLabel(severity) {
  const key = cleanText(severity) || 'watch';
  return SEVERITY_LABELS[key] ?? '观察';
}

function alertMessage(display, alert) {
  return typeof display.message === 'function' ? display.message(alert) : display.message;
}

function missedDigestPendingMessage(alert) {
  const reason = guardianReasonLabel(alertReason(alert)) || '通知摘要链路暂时不可用';
  return `系统发现有待补发的通知摘要，但当前${reason}。恢复后会自动补发；如持续出现，请检查 Guardian 的 digest/coordinator/outbox 状态。`;
}

function alertReason(alert) {
  const evidence = alert?.evidence;
  if (evidence && !Array.isArray(evidence) && typeof evidence === 'object') {
    return evidence.reason;
  }
  return reasonFromMessage(alert?.message);
}

function reasonFromMessage(message) {
  const text = cleanText(message);
  const reason = text.split(':').pop()?.trim() ?? '';
  return reason.includes('_') ? reason : '';
}

function alertMeta(alert, severityLabel) {
  const parts = [
    `范围：${projectScope(alert?.project_id)}`,
    `级别：${severityLabel}`,
    alert?.issue_id ? `issue #${alert.issue_id}` : '',
    alert?.watchdog_seen_at ? `seen ${formatDate(alert.watchdog_seen_at)}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function projectScope(projectId) {
  const value = cleanText(projectId);
  return value === '' || value === '-' ? '系统级' : `项目 ${value}`;
}

function fallbackDisplay() {
  return {
    message: 'Guardian 发现一条系统告警，可能影响自动恢复或通知链路。请检查 Guardian 状态页和后端日志。',
    title: 'Guardian 系统告警',
  };
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
