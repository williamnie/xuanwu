const DEFAULT_SUGGESTION_LIMIT = 8;
const DEFAULT_CONTEXT_LOOKBACK = 80;

export function filterPromptSuggestionItems(items, context, limit = DEFAULT_SUGGESTION_LIMIT) {
  if (!context || !Array.isArray(items)) return [];
  const query = normalizeSearchText(context.query);
  return items
    .filter((item) => item?.trigger === context.trigger)
    .filter((item) => matchesPromptSuggestion(item, query))
    .slice(0, limit);
}

export function detectPromptSuggestionContext(editor, triggerChars = ['/', '@']) {
  if (!editor?.state?.selection?.empty) return null;
  const triggers = new Set(triggerChars);
  if (triggers.size === 0) return null;
  const { state } = editor;
  const { from } = state.selection;
  const start = Math.max(0, from - DEFAULT_CONTEXT_LOOKBACK);
  const textBefore = state.doc.textBetween(start, from, '\n', '\0');
  const context = contextFromAlias(textBefore, from) || contextFromPlainTrigger(textBefore, from);
  if (!context || !triggers.has(context.trigger)) return null;
  return context;
}

export function samePromptSuggestionContext(left, right) {
  return left?.trigger === right?.trigger &&
    left?.query === right?.query &&
    left?.from === right?.from &&
    left?.to === right?.to;
}

export function nextPromptSuggestionIndex(current, delta, count) {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

export function promptSuggestionKeyAction(event) {
  if (!event) return '';
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  if (event.key === 'Escape') return 'close';
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    return 'pick';
  }
  return '';
}

export function scrollPromptSuggestionIntoView(element) {
  if (!element || typeof element.scrollIntoView !== 'function') return false;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

export function insertPromptSuggestion(editor, context, item) {
  const text = item?.insertText || '';
  if (!editor || !context || !text) return false;
  const tr = editor.state.tr.insertText(text, context.from, context.to);
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

export function removePromptSuggestionTrigger(editor, context) {
  if (!editor || !context) return false;
  const tr = editor.state.tr.delete(context.from, context.to);
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

function contextFromPlainTrigger(textBefore, from) {
  const match = /(^|[\s([{])([/@])([^\s/@]*)$/.exec(textBefore);
  if (!match) return null;
  const query = match[3] || '';
  return { trigger: match[2], query, from: from - match[2].length - query.length, to: from };
}

function contextFromAlias(textBefore, from) {
  const match = /(^|[\s([{])([/@])(project|issue|skill|plugin|file|folder)\s+([^\n]*)$/i.exec(textBefore);
  if (!match) return null;
  const alias = match[3].toLowerCase();
  const query = match[4] || '';
  return {
    trigger: match[2],
    query: `${alias} ${query}`.trim(),
    from: from - `${match[2]}${match[3]} ${query}`.length,
    to: from,
  };
}

function matchesPromptSuggestion(item, query) {
  if (!query) return true;
  return normalizeSearchText([
    item.label,
    item.description,
    item.searchText,
    item.insertText,
  ].filter(Boolean).join(' ')).includes(query);
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}
