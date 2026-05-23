const HIDDEN_DETAIL_KEYS = new Set(['encrypted_content']);
const EMPTY_DETAIL_KEYS = new Set(['type', 'status', 'call_id', 'id']);

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
  return Boolean(running && liveEvents?.length > 0);
}

export function parseLiveSessionEvents(liveEvents) {
  let agentMessageText = '';
  const tools = [];
  let activeTool = null;

  for (const event of liveEvents || []) {
    const type = agentEventType(event);
    const method = event.raw_method || event.method;
    const text = event.text || '';

    if (type === 'agent.message.delta') {
      agentMessageText += text;
    } else if (type === 'agent.command.output_delta') {
      if (activeTool && activeTool.type === 'commandExecution') {
        activeTool.text += text;
      }
    } else if (type === 'agent.file.patch') {
      if (activeTool && activeTool.type === 'fileChange') {
        activeTool.text += text;
      } else {
        const item = liveNormalizedItem(event);
        if (item && isRenderableToolItem(item)) tools.push(item);
      }
    } else if (type === 'agent.command.started' || method === 'item/started') {
      const item = liveEventItem(event);
      if (!item) continue;
      activeTool = liveToolFromItem(item);
      if (activeTool && isRenderableToolItem(activeTool)) tools.push(activeTool);
    } else if (type === 'agent.command.completed' || method === 'item/completed') {
      const item = liveEventItem(event);
      if (item && !updatesActiveTool(activeTool, item) && isRenderableToolItem(item)) {
        tools.push(item);
      }
      if (activeTool) activeTool.status = 'completed';
    } else {
      const item = liveFallbackItem(event);
      if (item) tools.push(item);
    }
  }

  return { tools, agentMessageText };
}

function agentEventType(event) {
  if (event?.agent_event_type) return event.agent_event_type;
  const method = event?.method || event?.raw_method || '';
  if (method === 'item/agentMessage/delta') return 'agent.message.delta';
  if (method === 'item/commandExecution/outputDelta') return 'agent.command.output_delta';
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') return 'agent.file.patch';
  if (method === 'turn/started') return 'agent.turn.started';
  if (method === 'turn/completed') return 'agent.turn.completed';
  if (method === 'error') return 'agent.error';
  return '';
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
  if (type === 'agent.command.started' || type === 'agent.command.completed') {
    return {
      type: 'commandExecution',
      command: event.command || commandFromText(event.text),
      text: type === 'agent.command.completed' ? event.text || '' : '',
      status: event.status || (type === 'agent.command.completed' ? 'completed' : 'inProgress'),
    };
  }
  if (type === 'agent.file.patch') {
    return {
      type: 'fileChange',
      path: event.path || '',
      text: event.text || '',
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
  const body = firstNonEmpty(event.text, event.error, event.status, event.payload);
  if (!event.method || !body) return null;
  return { type: event.method, text: body };
}

function updatesActiveTool(activeTool, item) {
  return Boolean(activeTool && item && activeTool.type === item.type && ['commandExecution', 'fileChange'].includes(item.type));
}
