

export function agentEventType(event) {
  if (event?.type === 'pi.conversation.event') return piAgentEventType(event);
  if (event?.agent_event_type) return normalizedProviderAgentEventType(event.agent_event_type);
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

export function normalizedProviderAgentEventType(type) {
  if (type === 'turn_started') return 'agent.turn.started';
  if (type === 'text' || type === 'text_delta' || type === 'message' || type === 'provider.message') return 'agent.message.delta';
  if (type === 'tool') return 'agent.command.started';
  if (type === 'tool_result') return 'agent.command.completed';
  if (type === 'done') return 'agent.turn.completed';
  if (type === 'error') return 'agent.error';
  return type;
}

export function piAgentEventType(event) {
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

export function isReasoningMethod(method) {
  return /reasoning|thinking/i.test(method || '');
}

export function liveEventItem(event) {
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

export function liveNormalizedItem(event) {
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

export function commandFromText(text) {
  if (!text) return '';
  return text.startsWith('$ ') ? text.slice(2) : text;
}

export function liveToolFromItem(item) {
  if (!item) return null;
  if (item.type === 'commandExecution') {
    return { ...item, command: item.command || '', text: item.text || '', status: item.status || 'inProgress' };
  }
  if (item.type === 'fileChange') {
    return { ...item, text: item.text || '', status: item.status || 'inProgress' };
  }
  return item;
}

export function liveFallbackItem(event) {
  const method = event.method || event.raw_method;
  const body = firstNonEmpty(event.text, event.error, event.status, event.payload, event.raw_payload);
  if (!method || !body) return null;
  return { type: method, text: summarizeBody(body), status: event.status || '' };
}

export function eventPayload(event) {
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

export function commandFromPayload(payload) {
  const command = payload.command || payload.item?.command;
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

export function patchTextFromPayload(payload) {
  if (typeof payload.delta === 'string') return payload.delta;
  if (!Array.isArray(payload.changes)) return '';
  return payload.changes.map((change) => `--- ${change.path || ''}\n${change.diff || ''}`).join('\n');
}

export function approvalItem(event) {
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

export function approvalSummary(method, params) {
  const lines = [`${method || 'approval/requested'} 正在等待用户决策。`];
  const command = commandFromPayload(params);
  if (command) lines.push(`Command: ${command}`);
  if (params.cwd) lines.push(`cwd: ${params.cwd}`);
  return lines.join('\n');
}

export function summarizeBody(value) {
  const text = String(value);
  return text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text;
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value);
    if (text.trim()) return text;
  }
  return '';
}
