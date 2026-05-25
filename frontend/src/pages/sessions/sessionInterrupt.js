export const INTERRUPT_STATUS_PENDING = 'pending';
export const INTERRUPT_STATUS_DONE = 'done';
export const INTERRUPT_STATUS_ERROR = 'error';

export function isInterruptPendingForSession(interruptState, sessionId) {
  return interruptState?.sessionId === sessionId &&
    interruptState?.status === INTERRUPT_STATUS_PENDING;
}

export function interruptRequestNotice(sessionId, result = {}) {
  if (!result?.interrupted) {
    return {
      sessionId,
      status: INTERRUPT_STATUS_DONE,
      tone: 'info',
      text: '当前没有可中断的 Codex turn。',
    };
  }
  const issue = result.issue;
  const issueText = issue?.id ? `，关联 Issue #${issue.id} 已进入 ${issue.status || 'cancelled'} 回收` : '';
  return {
    sessionId,
    status: INTERRUPT_STATUS_PENDING,
    tone: 'info',
    text: `已请求中断${issueText}，等待 Codex turn completed/cancelled/error 事件。`,
  };
}

export function interruptFailureNotice(sessionId, error) {
  return {
    sessionId,
    status: INTERRUPT_STATUS_ERROR,
    tone: 'error',
    text: `中断请求失败：${error?.message || '未知错误'}`,
  };
}

export function interruptCompletionNotice(sessionId, event) {
  const kind = sessionStopKind(event);
  if (kind === 'error') {
    return {
      sessionId,
      status: INTERRUPT_STATUS_ERROR,
      tone: 'error',
      text: `中断后 turn 返回错误：${eventErrorText(event)}`,
    };
  }
  if (kind === 'cancelled') {
    return {
      sessionId,
      status: INTERRUPT_STATUS_DONE,
      tone: 'success',
      text: '中断已生效，Codex turn 已取消。',
    };
  }
  return {
    sessionId,
    status: INTERRUPT_STATUS_DONE,
    tone: 'success',
    text: 'Codex turn 已结束，中断状态已回收。',
  };
}

export function isSessionStopEvent(event) {
  return Boolean(sessionStopKind(event));
}

export function sessionStopKind(event) {
  const type = normalizeStatusValue(event?.agent_event_type);
  const method = normalizeStatusValue(event?.method || event?.raw_method);
  const status = normalizeStatusValue(event?.status);
  if (type === 'agent.error' || method === 'error') return 'error';
  if (type === 'agent.turn.cancelled' || type === 'agent.turn.canceled') return 'cancelled';
  if (method === 'turn.cancelled' || method === 'turn.canceled') return 'cancelled';
  if (method === 'turn/cancelled' || method === 'turn/canceled') return 'cancelled';
  if (type === 'agent.turn.completed' || method === 'turn/completed') {
    return isCancelledStatus(status) ? 'cancelled' : 'completed';
  }
  return isCancelledStatus(status) && (type.startsWith('agent.turn.') || method.startsWith('turn/'))
    ? 'cancelled'
    : '';
}

function eventErrorText(event) {
  return event?.error || event?.text || payloadErrorText(event?.payload) || '未知错误';
}

function payloadErrorText(payload) {
  if (!payload || typeof payload !== 'string') return '';
  try {
    const parsed = JSON.parse(payload);
    return parsed?.error?.message || parsed?.error || '';
  } catch {
    return '';
  }
}

function isCancelledStatus(status) {
  return status === 'cancelled' || status === 'canceled';
}

function normalizeStatusValue(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}
