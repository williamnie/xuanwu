import { approvalsForSession } from './approvalQueue.js';
import { normalizeQueuedSessionMessages } from './sessionMessageQueue.js';

const DEFAULT_SESSION_PROVIDER = 'codex';
const MESSAGE_QUEUE_STORAGE_KEY = 'codex-session-message-queue';

export function readQueuedSessionMessages() {
  try {
    return normalizeQueuedSessionMessages(JSON.parse(window.localStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

export function persistQueuedSessionMessages(queue) {
  try {
    const active = normalizeQueuedSessionMessages(queue);
    window.localStorage.setItem(MESSAGE_QUEUE_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // localStorage 不可用时仅保留当前页面内队列。
  }
}

export function queuedMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function visibleApprovalsForSession(queue, selectedId) {
  const selected = approvalsForSession(queue, selectedId);
  if (selected.length > 0 || selectedId) return selected;
  return queue;
}

export function parseApprovalPayload(payload) {
  const request = approvalPayloadObject(payload);
  return {
    id: request.id || request.params?.approvalId || request.params?.itemId || request.params?.callId || '',
    method: request.method || 'approval/requested',
    params: request.params || {},
  };
}

function approvalPayloadObject(payload) {
  if (payload && typeof payload === 'object') return payload;
  try {
    const parsed = JSON.parse(payload || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizePendingApprovals(requests) {
  if (!Array.isArray(requests)) return [];
  return requests
    .map((request) => ({
      id: request?.id || '',
      method: request?.method || 'approval/requested',
      params: request?.params || {},
    }))
    .filter((request) => request.id);
}

export function parseApprovalResolvedPayload(payload) {
  try {
    const request = JSON.parse(payload || '{}');
    return { id: request.id || '' };
  } catch {
    return { id: '' };
  }
}

export function eventSessionKeyFromPayload(request) {
  return providerSessionKey(DEFAULT_SESSION_PROVIDER, request?.params?.threadId || '');
}

export function isSessionFileEvent(event) {
  return event?.type === 'session.created' || event?.type === 'session.updated';
}

export function isAgentEvent(event) {
  return event?.type === 'agent.event' ||
    event?.type === 'codex.event' ||
    event?.type === 'claude.event' ||
    (event?.type === 'issue.log' && Boolean(event?.threadId && event?.agent_event_type));
}

export function isSessionStartEvent(event) {
  return event?.agent_event_type === 'agent.turn.started' ||
    event?.agent_event_type === 'turn_started' ||
    event?.method === 'turn/started' ||
    event?.raw_method === 'turn/started';
}

export function providerSessionKey(provider = DEFAULT_SESSION_PROVIDER, sessionId = '') {
  const normalizedProvider = String(provider || DEFAULT_SESSION_PROVIDER).trim().toLowerCase();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';
  if (normalizedSessionId.startsWith(`${normalizedProvider}:`)) return normalizedSessionId;
  return `${normalizedProvider}:${normalizedSessionId}`;
}

export function chronologicalTurns(value) {
  return Array.isArray(value) ? [...value].reverse() : [];
}

export function mergeTurnPages(older, current) {
  const merged = new Map();
  for (const turn of [...older, ...current]) {
    const key = String(turn?.id || `turn-${merged.size}`);
    merged.set(key, turn);
  }
  return [...merged.values()];
}

export function eventSessionKey(event) {
  return providerSessionKey(event?.provider || DEFAULT_SESSION_PROVIDER, event?.threadId || '');
}

export function sessionIDFromCreateResult(result) {
  const provider = result?.provider || DEFAULT_SESSION_PROVIDER;
  return providerSessionKey(provider, result?.provider_session_id || result?.thread_id || result?.id || '');
}

export function sessionFromCreateResult(result, project = null) {
  const id = sessionIDFromCreateResult(result);
  if (!id) return null;
  const provider = String(result?.provider || id.split(':', 1)[0] || DEFAULT_SESSION_PROVIDER).trim();
  const providerSessionId = String(result?.provider_session_id || result?.thread_id || id.slice(provider.length + 1) || '').trim();
  const turnId = result?.turn_id || result?.provider_turn_id || '';
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    provider,
    provider_session_id: providerSessionId,
    thread_id: providerSessionId,
    project_id: project?.id || '',
    cwd: project?.cwd || '',
    preview: '',
    status: turnId ? 'running' : 'idle',
    isRunning: Boolean(turnId),
    createdAt: now,
    updatedAt: now,
  };
}

export function providerLabel(provider) {
  switch (String(provider || DEFAULT_SESSION_PROVIDER).toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'pi-coding-agent':
      return 'Pi Coding Agent';
    case 'qoder':
      return 'Qoder';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

export function mergeSessions(prev, next) {
  const seen = new Set(prev.map((item) => item.id));
  return [...prev, ...next.filter((item) => !seen.has(item.id))];
}

export function mergeRefreshedSessions(current, refreshed) {
  const refreshedIds = new Set(refreshed.map((item) => item.id));
  return [
    ...refreshed,
    ...current.filter((item) => !refreshedIds.has(item.id)),
  ];
}

export function isSessionRunning(session) {
  if (!session) return false;
  if (normalizePendingApprovals(session.pending_approvals).length > 0) return true;
  if (session.isRunning) return true;
  const value = sessionStatusValue(session.status);
  return ['running', 'inprogress', 'in-progress', 'streaming', 'busy'].includes(value);
}

function sessionStatusValue(status) {
  if (!status) return '';
  let value = status;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return normalizeSessionStatusValue(value);
    }
  }
  return normalizeSessionStatusValue(value.type || value.state || value.status || '');
}

function normalizeSessionStatusValue(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

export function setSessionRunningInList(list, id, running) {
  if (!id) return list;
  let changed = false;
  const next = list.map((session) => {
    if (session.id !== id || session.isRunning === running) return session;
    changed = true;
    return { ...session, isRunning: running };
  });
  return changed ? next : list;
}

export function upsertRunningSessionFromEvent(list, event, projects) {
  const id = eventSessionKey(event);
  if (!id) return list;
  if (list.some((session) => session.id === id)) return setSessionRunningInList(list, id, true);
  const project = projects.find((item) => item.id === event.projectId);
  const issueLabel = event.issueId ? `Issue #${event.issueId}` : 'Running issue';
  const timestamp = sessionEventTimestamp(event.created_at);
  return [{
    id,
    provider: event.provider || DEFAULT_SESSION_PROVIDER,
    provider_session_id: event.threadId,
    thread_id: event.threadId,
    project_id: event.projectId || '',
    cwd: project?.cwd || '',
    name: issueLabel,
    preview: `${issueLabel} 正在执行`,
    status: 'running',
    isRunning: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }, ...list];
}

function sessionEventTimestamp(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

export function syncSessionRuntimeInList(list, detail, running = isSessionRunning(detail)) {
  if (!detail?.id) return list;
  let changed = false;
  const next = list.map((session) => {
    if (session.id !== detail.id) return session;
    changed = true;
    return {
      ...session,
      name: detail.name ?? session.name,
      preview: detail.preview ?? session.preview,
      status: detail.status ?? session.status,
      origin: detail.origin ?? session.origin,
      updatedAt: detail.updatedAt ?? session.updatedAt,
      pending_approvals: detail.pending_approvals || [],
      isRunning: running,
    };
  });
  return changed ? next : list;
}
