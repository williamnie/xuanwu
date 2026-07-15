export function parseEventPayload(event) {
  if (!event?.payload) return {};
  if (typeof event.payload !== 'string') return event.payload;
  try {
    return JSON.parse(event.payload);
  } catch {
    return { text: event.payload };
  }
}

export function issueStatusFromEvent(event) {
  const directStatus = typeof event?.status === 'string' ? event.status : '';
  if (directStatus) return directStatus;
  const payload = parseEventPayload(event);
  return typeof payload.status === 'string' ? payload.status : '';
}

function legacyAgentEventType(method) {
  if (method === 'item/agentMessage/delta') return 'agent.message.delta';
  if (method === 'item/commandExecution/outputDelta') return 'agent.command.output_delta';
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') return 'agent.file.patch';
  if (method === 'turn/started') return 'agent.turn.started';
  if (method === 'turn/completed') return 'agent.turn.completed';
  if (method === 'error') return 'agent.error';
  return '';
}

export function issueLogAgentPayload(payload) {
  const rawMethod = payload.raw_method || payload.codexMethod || '';
  const text = payload.text || '';
  let type = payload.agent_event_type || legacyAgentEventType(rawMethod);
  if (!type && rawMethod === 'item/started' && (payload.command || text.startsWith('$ '))) {
    type = 'agent.command.started';
  }
  if (!type && rawMethod === 'item/completed' && text.startsWith('--- ')) {
    type = 'agent.file.patch';
  }
  if (!type) type = payload.type || '';
  return {
    type,
    rawMethod,
    text,
    command: payload.command || '',
    path: payload.path || '',
    status: payload.status || '',
    error: payload.error || '',
  };
}

export function commandLineText(agent) {
  const text = agent.command || agent.text || '';
  if (agent.text?.startsWith('! ')) return agent.text;
  return text.startsWith('$ ') ? text.slice(2) : text;
}

export function interruptEventLabel(type) {
  if (type === 'issue.interrupt_requested') return '已请求中断 Codex turn';
  if (type === 'issue.interrupted') return '中断回收完成';
  if (type === 'issue.interrupt_failed') return '中断请求失败';
  return '中断事件';
}

export function interruptReasonLabel(reason) {
  if (reason === 'session_interrupt') return '来自 Session interrupt';
  if (reason === 'issue_cancel') return '来自 Issue cancel';
  if (reason === 'interrupted_by_status_change') return '状态变更触发中断';
  return reason || 'interrupted';
}

export function mergeIssueLogEvents(events = []) {
  const merged = [];
  for (const event of events) {
    if (event.type === 'issue.comment') continue;

    const payload = parseEventPayload(event);
    const agent = issueLogAgentPayload(payload);
    const isDelta = event.type === 'issue.log'
      && (agent.type === 'agent.message.delta' || agent.type === 'agent.command.output_delta');
    const lastMerged = merged[merged.length - 1];
    const canMerge = isDelta
      && lastMerged?.type === 'issue.log'
      && lastMerged._agent?.type === agent.type;

    if (canMerge) {
      lastMerged._textMerged += agent.text || event.text || '';
      continue;
    }

    merged.push({
      ...event,
      _payload: payload,
      _agent: agent,
      _textMerged: agent.text || event.text || '',
    });
  }
  return merged;
}
