const HIDDEN_DETAIL_KEYS = new Set(['encrypted_content']);
const EMPTY_DETAIL_KEYS = new Set(['type', 'status', 'call_id', 'id']);

export function splitTextBySearchQuery(text, query) {
  const value = String(text ?? '');
  const needle = normalizeSearchQuery(query);
  if (!needle) return [{ text: value, match: false }];

  const haystack = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let cursor = 0;
  let matchIndex = haystack.indexOf(lowerNeedle);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) parts.push({ text: value.slice(cursor, matchIndex), match: false });
    const nextCursor = matchIndex + needle.length;
    parts.push({ text: value.slice(matchIndex, nextCursor), match: true });
    cursor = nextCursor;
    matchIndex = haystack.indexOf(lowerNeedle, cursor);
  }

  if (cursor < value.length) parts.push({ text: value.slice(cursor), match: false });
  return parts.length > 0 ? parts : [{ text: value, match: false }];
}

export function countSearchMatchesInText(text, query) {
  const value = String(text ?? '');
  const needle = normalizeSearchQuery(query);
  if (!value || !needle) return 0;

  const haystack = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let count = 0;
  let cursor = 0;
  let matchIndex = haystack.indexOf(lowerNeedle, cursor);

  while (matchIndex !== -1) {
    count += 1;
    cursor = matchIndex + needle.length;
    matchIndex = haystack.indexOf(lowerNeedle, cursor);
  }

  return count;
}

export function nextTranscriptSearchIndex(currentIndex, total, direction) {
  if (!Number.isFinite(total) || total <= 0) return -1;
  const step = direction < 0 ? -1 : 1;
  if (currentIndex < 0) return step < 0 ? total - 1 : 0;
  return (currentIndex + step + total) % total;
}

function normalizeSearchQuery(query) {
  return String(query ?? '').trim();
}

export function isRenderableToolItem(item) {
  if (!item || isMessageItem(item)) return false;
  if (item.type === 'commandExecution' || item.type === 'fileChange') return true;
  return Boolean(toolDisplayForItem(item));
}

export function toolDisplayForItem(item) {
  if (!item) return null;
  if (item.type === 'reasoning') {
    return reasoningDisplay(item);
  }
  if (item.type === 'approvalRequest') {
    return approvalDisplay(item);
  }
  if (isToolCall(item.type)) {
    return toolCallDisplay(item);
  }
  if (isToolOutput(item.type)) {
    return toolOutputDisplay(item);
  }
  return genericDisplay(item);
}

function reasoningDisplay(item) {
  const body = firstNonEmpty(extractText(item.summary), extractText(item.content), item.text);
  if (!body) return null;
  return { kind: 'reasoning', title: 'Reasoning', body };
}

function approvalDisplay(item) {
  return {
    kind: 'approval',
    title: '等待审批',
    body: firstNonEmpty(item.text, detailJSON(item)),
  };
}

function toolCallDisplay(item) {
  const title = `调用工具：${item.name || toolTypeLabel(item.type)}`;
  const body = firstNonEmpty(
    formatMaybeJSON(item.arguments),
    formatMaybeJSON(item.input),
    formatMaybeJSON(item.action),
    item.revised_prompt,
  );
  return body ? { kind: 'generic', title, body } : null;
}

function toolOutputDisplay(item) {
  const body = firstNonEmpty(
    formatMaybeJSON(item.output),
    formatMaybeJSON(item.tools),
    formatMaybeJSON(item.content),
  );
  return body ? { kind: 'generic', title: '工具输出', body } : null;
}

function genericDisplay(item) {
  const body = firstNonEmpty(item.text, item.output, item.input, item.arguments, item.delta, detailJSON(item));
  if (!body) return null;
  return { kind: 'generic', title: toolTypeLabel(item.type), body };
}

function isMessageItem(item) {
  return item.type === 'userMessage' || item.type === 'agentMessage';
}

function isToolCall(type) {
  return [
    'function_call',
    'custom_tool_call',
    'tool_search_call',
    'web_search_call',
    'image_generation_call',
  ].includes(type);
}

function isToolOutput(type) {
  return [
    'function_call_output',
    'custom_tool_call_output',
    'tool_search_output',
    'web_search_output',
  ].includes(type);
}

function toolTypeLabel(type) {
  const labels = {
    function_call: 'Function call',
    custom_tool_call: 'Custom tool call',
    tool_search_call: 'Tool search',
    web_search_call: 'Web search',
    image_generation_call: 'Image generation',
  };
  return labels[type] || type || '事件详情';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value);
    if (text.trim()) return text;
  }
  return '';
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return firstNonEmpty(value.text, value.content, value.summary);
  }
  return '';
}

function formatMaybeJSON(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function detailJSON(item) {
  const detail = {};
  for (const [key, value] of Object.entries(item)) {
    if (HIDDEN_DETAIL_KEYS.has(key) || EMPTY_DETAIL_KEYS.has(key)) continue;
    if (value == null || value === '' || isEmptyArray(value)) continue;
    detail[key] = value;
  }
  return Object.keys(detail).length > 0 ? JSON.stringify(detail, null, 2) : '';
}

function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

export function shouldRenderLiveTurn(liveEvents, running) {
  return Boolean(running || hasLiveError(liveEvents) || hasPendingApproval(liveEvents));
}

export function parseLiveSessionEvents(liveEvents, persistedTurns = []) {
  let agentMessageText = '';
  let reasoningText = '';
  let errorText = '';
  let approvalPending = false;
  let activity = 'thinking';
  const state = { tools: [], activeTool: null };

  for (const event of liveEvents || []) {
    const type = agentEventType(event);
    const method = event.raw_method || event.method;
    const payload = eventPayload(event);
    const text = firstNonEmpty(event.text, payload.delta, payload.text);

    if (type === 'agent.message.delta') {
      agentMessageText += text;
      activity = 'streaming';
    } else if (type === 'agent.reasoning.delta') {
      reasoningText += text;
    } else if (type === 'agent.command.output_delta') {
      appendCommandDelta(state, event, text);
      activity = 'command';
    } else if (type === 'agent.file.patch') {
      appendFilePatch(state, event, text);
      activity = 'file-change';
    } else if (type === 'agent.command.started' || method === 'item/started') {
      activity = startLiveItem(state, event, activity);
    } else if (type === 'agent.command.completed' || method === 'item/completed') {
      completeLiveItem(state, event);
    } else if (type === 'agent.approval.requested' || event.method === 'approval/requested') {
      approvalPending = true;
      activity = 'approval';
      state.tools.push(approvalItem(event));
    } else if (type === 'agent.error' || event.method === 'error') {
      errorText = firstNonEmpty(event.error, text, payload.error?.message, event.payload);
      appendFallbackItem(state, event);
    } else if (type === 'agent.turn.started' || type === 'agent.turn.completed') {
      // Lifecycle events drive the live banner; avoid noisy detail rows.
    } else {
      appendFallbackItem(state, event);
    }
  }

  const rawAgentMessageText = agentMessageText;
  agentMessageText = dedupePersistedLiveAgentText(agentMessageText, persistedTurns);
  const agentMessageDeduped = Boolean(rawAgentMessageText.trim()) && !agentMessageText.trim();

  return {
    tools: state.tools, agentMessageText, agentMessageDeduped, reasoningText,
    errorText, approvalPending, activity,
  };
}

export function dedupePersistedLiveAgentText(liveText, persistedTurns = []) {
  const text = String(liveText || '');
  if (!text.trim()) return text;
  const persistedText = latestPersistedAgentText(persistedTurns);
  if (!persistedText) return text;
  return normalizeMessageText(persistedText) === normalizeMessageText(text) ? '' : text;
}

function latestPersistedAgentText(turns = []) {
  if (!Array.isArray(turns)) return '';
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items || [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item?.type === 'agentMessage') return String(item.text || '');
    }
  }
  return '';
}

function normalizeMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function appendCommandDelta(state, event, text) {
  if (state.activeTool?.type === 'commandExecution') {
    state.activeTool.text += text;
  } else if (text) {
    state.activeTool = { type: 'commandExecution', command: event.command || '', text, status: 'streaming' };
    state.tools.push(state.activeTool);
  }
}

function appendFilePatch(state, event, text) {
  if (state.activeTool?.type === 'fileChange') {
    state.activeTool.text += text;
    return;
  }
  const item = liveNormalizedItem(event);
  if (item && isRenderableToolItem(item)) state.tools.push(item);
}

function startLiveItem(state, event, activity) {
  const item = liveEventItem(event);
  if (!item) return activity;
  state.activeTool = liveToolFromItem(item);
  if (state.activeTool && isRenderableToolItem(state.activeTool)) state.tools.push(state.activeTool);
  return state.activeTool?.type === 'commandExecution' ? 'command' : activity;
}

function completeLiveItem(state, event) {
  const item = liveEventItem(event);
  if (item && !updatesActiveTool(state.activeTool, item) && isRenderableToolItem(item)) {
    state.tools.push(item);
  }
  if (state.activeTool) state.activeTool.status = 'completed';
}

function appendFallbackItem(state, event) {
  const item = liveFallbackItem(event);
  if (item) state.tools.push(item);
}

function agentEventType(event) {
  if (event?.type === 'pi.conversation.event') return piAgentEventType(event);
  if (event?.agent_event_type) return event.agent_event_type;
  const method = event?.method || event?.raw_method || '';
  if (method === 'item/agentMessage/delta') return 'agent.message.delta';
  if (method === 'item/commandExecution/outputDelta') return 'agent.command.output_delta';
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') return 'agent.file.patch';
  if (isReasoningMethod(method)) return 'agent.reasoning.delta';
  if (method === 'approval/requested') return 'agent.approval.requested';
  if (method === 'turn/started') return 'agent.turn.started';
  if (method === 'turn/completed') return 'agent.turn.completed';
  if (method === 'error') return 'agent.error';
  return '';
}

function piAgentEventType(event) {
  const type = event?.agent_event_type || eventPayload(event).type || '';
  if (type === 'agent_start') return 'agent.turn.started';
  if (type === 'agent_end') return 'agent.turn.completed';
  if (type === 'message_update' && eventPayload(event).role === 'assistant') return 'agent.message.delta';
  if (type === 'message_end' && eventPayload(event).role === 'assistant') return 'agent.message.delta';
  if (type === 'tool_execution_start') return 'agent.command.started';
  if (type === 'tool_execution_update') return 'agent.command.output_delta';
  if (type === 'tool_execution_end') return 'agent.command.completed';
  return type;
}

function isReasoningMethod(method) {
  return /reasoning|thinking/i.test(method || '');
}

function liveEventItem(event) {
  const normalized = liveNormalizedItem(event);
  if (normalized) return normalized;
  try {
    const payload = JSON.parse(event.payload || '{}');
    return payload.item || null;
  } catch {
    if (event.payload?.includes('commandExecution')) return { type: 'commandExecution' };
    if (event.payload?.includes('fileChange')) return { type: 'fileChange' };
    return null;
  }
}

function liveNormalizedItem(event) {
  const type = agentEventType(event);
  const payload = eventPayload(event);
  if (type === 'agent.command.started' || type === 'agent.command.completed') {
    return {
      type: 'commandExecution',
      command: event.command || commandFromPayload(payload) || commandFromText(event.text),
      text: type === 'agent.command.completed' ? event.text || '' : '',
      status: event.status || payload.item?.status || (type === 'agent.command.completed' ? 'completed' : 'inProgress'),
      cwd: payload.cwd || payload.item?.cwd || '',
    };
  }
  if (type === 'agent.file.patch') {
    return {
      type: 'fileChange',
      path: event.path || payload.path || '',
      text: event.text || patchTextFromPayload(payload),
      status: event.status || 'completed',
    };
  }
  return null;
}

function commandFromText(text) {
  if (!text) return '';
  return text.startsWith('$ ') ? text.slice(2) : text;
}

function liveToolFromItem(item) {
  if (!item) return null;
  if (item.type === 'commandExecution') {
    return { ...item, command: item.command || '', text: item.text || '', status: item.status || 'inProgress' };
  }
  if (item.type === 'fileChange') {
    return { ...item, text: item.text || '', status: item.status || 'inProgress' };
  }
  return item;
}

function liveFallbackItem(event) {
  const method = event.method || event.raw_method;
  const body = firstNonEmpty(event.text, event.error, event.status, event.payload, event.raw_payload);
  if (!method || !body) return null;
  return { type: method, text: summarizeBody(body), status: event.status || '' };
}

function updatesActiveTool(activeTool, item) {
  return Boolean(activeTool && item && activeTool.type === item.type && ['commandExecution', 'fileChange'].includes(item.type));
}

function eventPayload(event) {
  for (const value of [event?.payload, event?.raw_payload]) {
    if (!value || typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Ignore malformed provider payloads; raw text remains visible via fallback.
    }
  }
  return {};
}

function commandFromPayload(payload) {
  const command = payload.command || payload.item?.command;
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

function patchTextFromPayload(payload) {
  if (typeof payload.delta === 'string') return payload.delta;
  if (!Array.isArray(payload.changes)) return '';
  return payload.changes.map((change) => `--- ${change.path || ''}\n${change.diff || ''}`).join('\n');
}

function approvalItem(event) {
  const payload = eventPayload(event);
  const params = payload.params || {};
  return {
    type: 'approvalRequest',
    method: payload.method || event.raw_method || '',
    text: approvalSummary(payload.method || event.raw_method, params),
    status: 'pending',
    command: commandFromPayload(params),
    cwd: params.cwd || '',
  };
}

function approvalSummary(method, params) {
  const lines = [`${method || 'approval/requested'} 正在等待用户决策。`];
  const command = commandFromPayload(params);
  if (command) lines.push(`Command: ${command}`);
  if (params.cwd) lines.push(`cwd: ${params.cwd}`);
  return lines.join('\n');
}

function summarizeBody(value) {
  const text = String(value);
  return text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text;
}

function hasLiveError(liveEvents) {
  return (liveEvents || []).some((event) => agentEventType(event) === 'agent.error' || event?.method === 'error');
}

function hasPendingApproval(liveEvents) {
  return (liveEvents || []).some((event) => agentEventType(event) === 'agent.approval.requested' || event?.method === 'approval/requested');
}
