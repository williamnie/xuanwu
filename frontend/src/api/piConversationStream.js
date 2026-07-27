import { fetchEventSource } from '@microsoft/fetch-event-source';
import { authHeader } from './authToken.js';
import { apiUrl } from './base.js';
import { storedLanguage } from '../i18n/translations.js';

const TERMINAL_EVENTS = new Set(['completed', 'error', 'failed']);

export class PiConversationStreamError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PiConversationStreamError';
    this.backgroundRunning = Boolean(options.backgroundRunning);
    this.kind = options.kind || 'stream';
    this.status = options.status || 0;
    this.turnId = options.turnId || '';
  }
}

export async function streamPiConversationMessage(id, message, options = {}) {
  const conversationId = String(id || '').trim();
  const signal = options.signal;
  let accepted = false;
  let terminal = null;
  let turnId = '';

  await fetchEventSource(apiUrl(`/api/pi/conversations/${encodeURIComponent(conversationId)}/messages`), {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Codex-Client': 'xuanwu-web',
      'Accept-Language': storedLanguage(),
      ...authHeader(),
      ...options.headers,
    },
    body: JSON.stringify(typeof message === 'string' ? { prompt: message } : message),
    signal,
    fetch: options.fetch,
    openWhenHidden: true,
    async onopen(response) {
      if (!response.ok) {
        throw new PiConversationStreamError(await responseErrorMessage(response), {
          kind: 'http',
          status: response.status,
        });
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('text/event-stream')) {
        throw new PiConversationStreamError(`消息接口未返回 SSE: ${contentType || 'unknown content-type'}`, {
          kind: 'protocol',
        });
      }
    },
    onmessage(messageEvent) {
      const event = String(messageEvent.event || '').trim();
      if (!event) return;
      const data = parseEventData(messageEvent.data, event);
      const eventConversationId = String(data.conversation_id || '');
      if (eventConversationId && eventConversationId !== conversationId) {
        throw new PiConversationStreamError('收到其他 Chat 的流事件，已停止消费', { kind: 'protocol', turnId });
      }
      const eventTurnId = String(data.turn_id || messageEvent.id || '').trim();
      if (!eventTurnId) {
        throw new PiConversationStreamError(`SSE ${event} 缺少 turn_id`, { kind: 'protocol', turnId });
      }
      if (turnId && eventTurnId !== turnId) {
        throw new PiConversationStreamError('同一响应中出现多个 Turn，已停止消费', { kind: 'protocol', turnId });
      }
      turnId = eventTurnId;
      if (event === 'accepted') accepted = true;
      const normalized = { data, event, id: messageEvent.id || eventTurnId, turnId: eventTurnId };
      options.onEvent?.(normalized);
      if (TERMINAL_EVENTS.has(event)) terminal = normalized;
    },
    onclose() {
      if (!terminal && !signal?.aborted) {
        throw disconnectedError(accepted, turnId);
      }
    },
    onerror(error) {
      if (signal?.aborted) throw error;
      if (error instanceof PiConversationStreamError) throw error;
      throw disconnectedError(accepted, turnId, error);
    },
  });

  if (signal?.aborted) {
    return { status: 'aborted', turn_id: turnId };
  }
  if (!terminal) throw disconnectedError(accepted, turnId);
  if (terminal.event === 'completed') return terminal.data;
  throw providerError(terminal);
}

function parseEventData(value, event) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the protocol error below.
  }
  throw new PiConversationStreamError(`SSE ${event} data 不是有效 JSON`, { kind: 'protocol' });
}

function providerError(terminal) {
  const detail = terminal.data?.error;
  const message = typeof detail === 'string'
    ? detail
    : String(detail?.message || terminal.data?.message || 'Xuanwu 执行失败，未返回错误详情');
  return new PiConversationStreamError(message, {
    kind: terminal.event === 'error' ? 'server' : 'provider',
    turnId: terminal.turnId,
  });
}

function disconnectedError(accepted, turnId, cause = null) {
  const message = accepted
    ? '连接已中断，Xuanwu 可能仍在后台运行；请稍后刷新当前 Chat 获取最终结果'
    : '消息连接未能确认，Xuanwu 可能已在后台启动；为避免重复 Turn，本次不会自动重试';
  const error = new PiConversationStreamError(message, {
    backgroundRunning: true,
    kind: 'disconnected',
    turnId,
  });
  if (cause) error.cause = cause;
  return error;
}

async function responseErrorMessage(response) {
  const text = await response.text();
  if (!text) return `请求失败: ${response.status}`;
  try {
    const data = JSON.parse(text);
    return data.message || `请求失败: ${response.status}`;
  } catch {
    return text;
  }
}
