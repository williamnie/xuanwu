import { ensureAuthCookie } from './authToken.js';
import { apiUrl, request } from './base.js';

const EVENT_SOURCE_CLOSED = 2;

let sharedEventSource = null;
const eventSubscribers = new Set();

/**
 * @param {(data: unknown) => void} onEvent
 * @param {(error: Event) => void} [onError]
 * @param {() => void} [onOpen]
 */
function subscribeToEvents(onEvent, onError, onOpen) {
  const subscriber = { onEvent, onError, onOpen };
  eventSubscribers.add(subscriber);
  ensureSharedEventSource();

  return () => {
    eventSubscribers.delete(subscriber);
    if (eventSubscribers.size === 0) {
      sharedEventSource?.close();
      sharedEventSource = null;
    }
  };
}

function ensureSharedEventSource() {
  if (sharedEventSource && sharedEventSource.readyState !== EVENT_SOURCE_CLOSED) {
    return sharedEventSource;
  }

  ensureAuthCookie();
  sharedEventSource = new EventSource(apiUrl('/api/events'));
  sharedEventSource.onopen = () => {
    for (const subscriber of eventSubscribers) {
      subscriber.onOpen?.();
    }
  };
  sharedEventSource.onmessage = (event) => {
    dispatchEventMessage(event);
  };
  sharedEventSource.onerror = (err) => {
    for (const subscriber of eventSubscribers) {
      subscriber.onError?.(err);
    }
  };
  return sharedEventSource;
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
