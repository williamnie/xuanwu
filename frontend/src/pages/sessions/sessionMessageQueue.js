import { normalizeReferences } from './sessionReferences.js';

const ACTIVE_STATUSES = new Set(['pending', 'sending', 'failed']);

export function createQueuedSessionMessage({ id, sessionId, prompt, settings = {}, references = [], createdAt }) {
  const text = String(prompt || '').trim();
  const refs = normalizeReferences(references);
  if (!id || !sessionId || (!text && refs.length === 0)) return null;
  return {
    id,
    sessionId,
    prompt: text,
    references: refs,
    settings: copyMessageSettings(settings),
    status: 'pending',
    createdAt: createdAt || new Date().toISOString(),
    error: '',
  };
}

export function normalizeQueuedSessionMessages(queue) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((item) => item?.id && item?.sessionId && (String(item.prompt || '').trim() || normalizeReferences(item.references).length > 0))
    .map((item) => normalizeQueuedMessage(item));
}

export function enqueueQueuedSessionMessage(queue, message) {
  if (!message?.id) return queue;
  if (queue.some((item) => item.id === message.id)) return queue;
  return [...queue, normalizeQueuedMessage(message)];
}

export function nextPendingQueuedSessionMessage(queue, sessionId) {
  const next = queue.find((item) => item.sessionId === sessionId) || null;
  return next?.status === 'pending' ? next : null;
}

export function markQueuedSessionMessageSending(queue, id) {
  return queue.map((item) => item.id === id ? { ...item, status: 'sending', error: '' } : item);
}

export function markQueuedSessionMessageFailed(queue, id, error) {
  return queue.map((item) => item.id === id ? { ...item, status: 'failed', error: String(error || '发送失败') } : item);
}

export function retryQueuedSessionMessage(queue, id) {
  return queue.map((item) => item.id === id ? { ...item, status: 'pending', error: '' } : item);
}

export function removeQueuedSessionMessage(queue, id) {
  return queue.filter((item) => item.id !== id);
}

function normalizeQueuedMessage(item) {
  const status = ACTIVE_STATUSES.has(item.status) ? item.status : 'pending';
  if (status === 'sending') {
    return {
      ...item,
      settings: copyMessageSettings(item.settings),
      references: normalizeReferences(item.references),
      status: 'failed',
      error: item.error || '页面刷新时消息正在发送，已暂停以避免重复发送。',
    };
  }
  return {
    ...item,
    prompt: String(item.prompt || '').trim(),
    settings: copyMessageSettings(item.settings),
    references: normalizeReferences(item.references),
    status,
    error: item.error || '',
  };
}

function copyMessageSettings(settings = {}) {
  return {
    model: settings.model || '',
    reasoningEffort: settings.reasoningEffort || '',
    serviceTier: settings.serviceTier || '',
    approvalPolicy: settings.approvalPolicy || '',
    sandbox: settings.sandbox || '',
  };
}
