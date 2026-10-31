import { agentEventType, eventPayload, firstNonEmpty, approvalItem, liveNormalizedItem, liveEventItem, liveToolFromItem, liveFallbackItem } from './sessionProviderEvents.js';
import { isRenderableToolItem } from './sessionToolDisplay.js';

export function shouldRenderLiveTurn(liveEvents, running) {
  return Boolean(running || hasLiveError(liveEvents) || hasPendingApproval(liveEvents));
}

export function liveActivityStatus(parsed) {
  if (parsed.errorText) return { tone: 'error', label: `运行出错：${parsed.errorText}` };
  if (parsed.approvalPending) return { tone: 'approval', label: '已暂停，等待审批' };
  const labels = {
    streaming: '正在输出回复',
    command: '正在运行命令',
    'file-change': '正在整理文件改动',
  };
  return { tone: 'running', label: labels[parsed.activity] || '正在思考' };
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

export function latestPersistedAgentText(turns = []) {
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

export function normalizeMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function appendCommandDelta(state, event, text) {
  if (state.activeTool?.type === 'commandExecution') {
    state.activeTool.text += text;
  } else if (text) {
    state.activeTool = { type: 'commandExecution', command: event.command || '', text, status: 'streaming' };
    state.tools.push(state.activeTool);
  }
}

export function appendFilePatch(state, event, text) {
  if (state.activeTool?.type === 'fileChange') {
    state.activeTool.text += text;
    return;
  }
  const item = liveNormalizedItem(event);
  if (item && isRenderableToolItem(item)) state.tools.push(item);
}

export function startLiveItem(state, event, activity) {
  const item = liveEventItem(event);
  if (!item) return activity;
  state.activeTool = liveToolFromItem(item);
  if (state.activeTool && isRenderableToolItem(state.activeTool)) state.tools.push(state.activeTool);
  return state.activeTool?.type === 'commandExecution' ? 'command' : activity;
}

export function completeLiveItem(state, event) {
  const item = liveEventItem(event);
  if (item && !updatesActiveTool(state.activeTool, item) && isRenderableToolItem(item)) {
    state.tools.push(item);
  }
  if (state.activeTool) {
    if (item?.text) state.activeTool.text = item.text;
    state.activeTool.status = item?.status || 'completed';
  }
}

export function appendFallbackItem(state, event) {
  const item = liveFallbackItem(event);
  if (item) state.tools.push(item);
}

export function updatesActiveTool(activeTool, item) {
  return Boolean(activeTool && item && activeTool.type === item.type && ['commandExecution', 'fileChange'].includes(item.type));
}

export function hasLiveError(liveEvents) {
  return (liveEvents || []).some((event) => agentEventType(event) === 'agent.error' || event?.method === 'error');
}

export function hasPendingApproval(liveEvents) {
  return (liveEvents || []).some((event) => agentEventType(event) === 'agent.approval.requested' || event?.method === 'approval/requested');
}
