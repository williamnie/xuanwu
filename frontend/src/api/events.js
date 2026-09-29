import { ensureAuthCookie } from './authToken.js';
import { apiUrl, request } from './base.js';

const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let sharedEventSource = null;
let reconnectTimer = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let lastConnectionError = null;
const eventSubscribers = new Set();

/**
 * @param {(data: unknown) => void} onEvent
 * @param {(error: Event) => void} [onError]
 * @param {() => void} [onOpen]
 */
function subscribeToEvents(onEvent, onError, onOpen) {
  const subscriber = { onEvent, onError, onOpen };
  eventSubscribers.add(subscriber);
  const source = ensureSharedEventSource();
  if (source?.readyState === EVENT_SOURCE_OPEN) onOpen?.();
  else if (lastConnectionError) onError?.(lastConnectionError);

  return () => {
    eventSubscribers.delete(subscriber);
    if (eventSubscribers.size === 0) {
      clearReconnectTimer();
      sharedEventSource?.close();
      sharedEventSource = null;
      lastConnectionError = null;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    }
  };
}

function ensureSharedEventSource() {
  if (sharedEventSource && sharedEventSource.readyState !== EVENT_SOURCE_CLOSED) {
    return sharedEventSource;
  }
  if (reconnectTimer !== null || eventSubscribers.size === 0) return sharedEventSource;

  ensureAuthCookie();
  sharedEventSource?.close();
  const source = new EventSource(apiUrl('/api/events'));
  sharedEventSource = source;
  source.onopen = () => {
    if (sharedEventSource !== source) return;
    clearReconnectTimer();
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    lastConnectionError = null;
    for (const subscriber of eventSubscribers) {
      subscriber.onOpen?.();
    }
  };
  source.onmessage = (event) => {
    if (sharedEventSource !== source) return;
    dispatchEventMessage(event);
  };
  source.onerror = (err) => {
    if (sharedEventSource !== source) return;
    lastConnectionError = err;
    // CONNECTING 由浏览器自动恢复；CLOSED 必须重新创建连接。
    if (source.readyState === EVENT_SOURCE_CLOSED) scheduleReconnect(source);
    for (const subscriber of eventSubscribers) {
      subscriber.onError?.(err);
    }
  };
  return sharedEventSource;
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(source) {
  if (reconnectTimer !== null || eventSubscribers.size === 0) return;
  reconnectTimer = setTimeout(() => {
    if (sharedEventSource !== source) return;
    reconnectTimer = null;
    ensureSharedEventSource();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

function dispatchEventMessage(event) {
  try {
    const data = JSON.parse(event.data);
    for (const subscriber of eventSubscribers) {
      subscriber.onEvent?.(data);
    }
  } catch (err) {
    console.error('解析 SSE 消息失败:', err, event.data);
  }
}

export function eventSummaryParams({ afterId, beforeId, excludeTypes, limit, projectId = '', types }) {
  const params = new URLSearchParams();
  if (afterId) params.append('after_id', String(afterId));
  if (beforeId) params.append('before_id', String(beforeId));
  for (const type of excludeTypes) params.append('exclude_type', type);
  if (limit) params.append('limit', String(limit));
  if (projectId) params.append('project_id', projectId);
  for (const type of types) params.append('type', type);
  return params;
}

export const eventsApi = {
  getEventSummaries: ({ afterId = '', beforeId = '', excludeTypes = [], limit = 0, projectId = '', types = [] } = {}) => {
    const params = eventSummaryParams({ afterId, beforeId, excludeTypes, limit, projectId, types });
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/event-summaries${query}`);
  },

  subscribeToEvents,
};
