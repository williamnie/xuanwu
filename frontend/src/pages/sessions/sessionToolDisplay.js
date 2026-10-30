import { firstNonEmpty } from './sessionProviderEvents.js';

export function isRenderableToolItem(item) {
  if (!item || isMessageItem(item)) return false;
  if (item.type === 'commandExecution' || item.type === 'fileChange') return true;
  // 折叠状态只判断是否有详情，展开后才序列化工具的完整参数/输出。
  if (item.type === 'reasoning') return Boolean(firstNonEmpty(extractText(item.summary), extractText(item.content), item.text));
  if (item.type === 'approvalRequest') return true;
  const fields = isToolCall(item.type)
    ? ['arguments', 'input', 'action', 'revised_prompt']
    : isToolOutput(item.type) ? ['output', 'tools', 'content']
      : ['text', 'output', 'input', 'arguments', 'delta'];
  if (fields.some((key) => hasDisplayValue(item[key]))) return true;
  if (isToolCall(item.type) || isToolOutput(item.type)) return false;
  return Object.entries(item).some(([key, value]) => (
    !HIDDEN_DETAIL_KEYS.has(key) && !EMPTY_DETAIL_KEYS.has(key)
    && value != null && value !== '' && !isEmptyArray(value)
  ));
}

export function isInspectableToolItem(item) {
  if (!item || isMessageItem(item) || isInternalProviderItem(item)) return false;
  return isRenderableToolItem(item);
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

export function reasoningDisplay(item) {
  const body = firstNonEmpty(extractText(item.summary), extractText(item.content), item.text);
  if (!body) return null;
  return { kind: 'reasoning', title: 'Reasoning', body };
}

export function approvalDisplay(item) {
  return {
    kind: 'approval',
    title: '等待审批',
    body: firstNonEmpty(item.text, detailJSON(item)),
  };
}

export function toolCallDisplay(item) {
  const title = `调用工具：${item.name || toolTypeLabel(item.type)}`;
  const body = firstNonEmpty(
    formatMaybeJSON(item.arguments),
    formatMaybeJSON(item.input),
    formatMaybeJSON(item.action),
    item.revised_prompt,
  );
  return body ? { kind: 'generic', title, body } : null;
}

export function toolOutputDisplay(item) {
  const body = firstNonEmpty(
    formatMaybeJSON(item.output),
    formatMaybeJSON(item.tools),
    formatMaybeJSON(item.content),
  );
  return body ? { kind: 'generic', title: '工具输出', body } : null;
}

export function genericDisplay(item) {
  const body = firstNonEmpty(
    formatMaybeJSON(item.text),
    formatMaybeJSON(item.output),
    formatMaybeJSON(item.input),
    formatMaybeJSON(item.arguments),
    formatMaybeJSON(item.delta),
    detailJSON(item),
  );
  if (!body) return null;
  return { kind: 'generic', title: toolTypeLabel(item.type), body };
}

export function isInternalProviderItem(item) {
  return /^mcpTool(?:Call|Result)$/i.test(String(item?.type || ''));
}

export function isMessageItem(item) {
  return item.type === 'userMessage' || item.type === 'agentMessage';
}

export function isToolCall(type) {
  return [
    'function_call',
    'custom_tool_call',
    'tool_search_call',
    'web_search_call',
    'image_generation_call',
  ].includes(type);
}

export function isToolOutput(type) {
  return [
    'function_call_output',
    'custom_tool_call_output',
    'tool_search_output',
    'web_search_output',
  ].includes(type);
}

export function toolTypeLabel(type) {
  const labels = {
    function_call: 'Function call',
    custom_tool_call: 'Custom tool call',
    tool_search_call: 'Tool search',
    web_search_call: 'Web search',
    image_generation_call: 'Image generation',
    permission: 'Permission',
    qoderNative: 'Coding tool event',
    subagent: 'Subagent',
  };
  return labels[type] || type || '事件详情';
}

export function hasDisplayValue(value) {
  return value != null && (typeof value !== 'string' || Boolean(value.trim()));
}

export function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return firstNonEmpty(value.text, value.content, value.summary);
  }
  return '';
}

export function formatMaybeJSON(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function detailJSON(item) {
  const detail = {};
  for (const [key, value] of Object.entries(item)) {
    if (HIDDEN_DETAIL_KEYS.has(key) || EMPTY_DETAIL_KEYS.has(key)) continue;
    if (value == null || value === '' || isEmptyArray(value)) continue;
    detail[key] = value;
  }
  return Object.keys(detail).length > 0 ? JSON.stringify(detail, null, 2) : '';
}

export function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

export const HIDDEN_DETAIL_KEYS = new Set(['encrypted_content']);

export const EMPTY_DETAIL_KEYS = new Set(['type', 'status', 'call_id', 'id']);
