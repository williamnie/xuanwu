import { runAvailableActions } from '../runs/runPageModel.js';

const ACTIVE_WORK_STATUSES = new Set(['todo', 'in_progress', 'needs_user']);

const PHASE_META = {
  queued: { label: '排队中', tone: 'queued' },
  starting: { label: '启动中', tone: 'running' },
  running: { label: '运行中', tone: 'running' },
  waiting_approval: { label: '等待审批', tone: 'waiting' },
  recovering: { label: '恢复中', tone: 'recovering' },
  pi_deciding: { label: 'PI 判断中', tone: 'verifying' },
  succeeded: { label: '已完成', tone: 'succeeded' },
  failed: { label: '失败', tone: 'failed' },
  cancelled: { label: '已停止', tone: 'cancelled' },
  interrupted: { label: '已暂停', tone: 'waiting' },
  unknown: { label: '状态未知', tone: 'unknown' },
};

export function activeWorkView(item, runDetail, now = new Date()) {
  const phase = activeWorkPhase(item);
  const progress = item?.latest_run?.progress || {};
  const stalled = progress.stalled || {};
  const progressAt = progress.latest?.occurred_at || progress.updated_at || item?.latest_run?.updated_at || item?.updated_at || '';
  return {
    duration: activeWorkDuration(item, runDetail, now),
    phase,
    phaseLabel: (PHASE_META[phase] || PHASE_META.unknown).label,
    progressAt,
    progressText: progress.latest?.summary || progressFallback(phase),
    stalled: Boolean(stalled.detected),
    stalledLabel: stalled.reason === 'waiting_approval' ? '等待审批' : '进展停滞',
    tone: (PHASE_META[phase] || PHASE_META.unknown).tone,
  };
}

export function activeWorkPhase(item) {
  if (item?.status === 'todo') return 'queued';
  if (item?.status === 'needs_user') return 'waiting_approval';
  if (item?.status === 'in_progress' && item?.latest_run?.ended_at) return 'pi_deciding';
  if (item?.latest_run?.status === 'recovering' || item?.latest_run?.phase === 'recovering') return 'recovering';
  return item?.latest_run?.phase || item?.latest_run?.status || (item?.status === 'in_progress' ? 'starting' : 'unknown');
}

export function activeWorkDuration(item, runDetail, now = new Date()) {
  const fallbackStart = item?.status === 'todo' || item?.status === 'needs_user' ? item?.updated_at : '';
  const start = runDetail?.started_at || fallbackStart;
  const end = runDetail?.ended_at || now;
  const elapsed = timestamp(end) - timestamp(start);
  if (!start || !Number.isFinite(elapsed) || elapsed < 0) return '—';
  return formatDuration(elapsed);
}

export function activeWorkCanPause(item, runDetail) {
  if (!activeWorkHasActiveRun(item) || !runDetail) return false;
  return runAvailableActions(runDetail).interrupt;
}

export function activeWorkHasActiveRun(item) {
  return ['running', 'recovering'].includes(item?.latest_run?.status);
}

export function activeWorkCanStop(item) {
  return ACTIVE_WORK_STATUSES.has(item?.status);
}

export function buildActiveWorkActionPayload(item, action, {
  nonce,
  occurredAt = new Date().toISOString(),
} = {}) {
  const eventNonce = String(nonce || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: `command-center:${item?.id || 'unknown'}`,
      event_id: `command-center:${action}:${eventNonce}`,
      occurred_at: occurredAt,
      reason: `Command Center Active Work requested ${action}`,
    },
    expected_revision: Number(item?.revision || 0),
  };
}

export function formatRelativeTime(value, now = new Date()) {
  const elapsed = timestamp(now) - timestamp(value);
  if (!value || !Number.isFinite(elapsed) || elapsed < 0) return '';
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

function progressFallback(phase) {
  if (phase === 'queued') return '等待 Runner 领取';
  if (phase === 'pi_deciding') return 'PI 正在读取 Session 并决定后续';
  if (phase === 'recovering') return '正在恢复执行';
  if (phase === 'waiting_approval') return '等待确定性权限门禁';
  return '等待 provider 进展事件';
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${Math.max(totalSeconds, 0)} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `${totalHours} 小时 ${minutes} 分` : `${totalHours} 小时`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
