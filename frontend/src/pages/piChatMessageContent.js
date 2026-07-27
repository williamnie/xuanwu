const CUSTOM_TAGS = [
  {
    name: 'runner_ui_context',
    parse: parseRunnerUiContext,
  },
];

export function parsePiChatMessageContent(value = '') {
  const text = String(value ?? '');
  const segments = [];
  let cursor = 0;

  while (cursor < text.length) {
    const match = nextCustomTag(text, cursor);
    if (!match) {
      pushMarkdownSegment(segments, text.slice(cursor));
      break;
    }

    pushMarkdownSegment(segments, text.slice(cursor, match.index));
    segments.push({
      context: match.definition.parse(match.body),
      raw: match.raw,
      type: match.definition.name,
    });
    cursor = match.index + match.raw.length;
  }

  return segments;
}

export function runnerContextModeLabel(mode, t = null) {
  if (mode === 'read_only') return copy(t, 'chat.context.readOnly', '只读上下文');
  if (mode === 'controlled') return copy(t, 'chat.context.controlled', '受控操作');
  return copy(t, 'chat.context.runtime', '运行上下文');
}

export function runnerContextReferenceLabel(reference = {}, t = null) {
  const fields = reference.fields || {};
  if (reference.type === 'page_context') {
    const page = pageLabel(fields.page_id);
    const run = compactRunLabel(fields.run_id);
    const work = compactWorkLabel(fields.work_id);
    return [page, run || work].filter(Boolean).join(' · ') || copy(t, 'chat.context.currentPage', '当前页面');
  }
  if (reference.type === 'project') return fields.id ? copy(t, 'chat.context.project', `项目 @${fields.id}`, { id: fields.id }) : copy(t, 'chat.context.projectContext', '项目上下文');
  if (reference.type === 'work') return compactWorkLabel(fields.id) || copy(t, 'chat.context.workContext', 'Work 上下文');
  return reference.type ? copy(t, 'chat.context.typedContext', `${reference.type} 上下文`, { type: reference.type }) : copy(t, 'chat.context.related', '关联上下文');
}

function nextCustomTag(text, offset) {
  let earliest = null;
  for (const definition of CUSTOM_TAGS) {
    const pattern = new RegExp(`<${definition.name}\\b[^>]*>([\\s\\S]*?)<\\/${definition.name}>`, 'gi');
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match || (earliest && match.index >= earliest.index)) continue;
    earliest = {
      body: match[1],
      definition,
      index: match.index,
      raw: match[0],
    };
  }
  return earliest;
}

function parseRunnerUiContext(body) {
  const context = { fields: {}, references: [] };
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'reference') {
      context.references.push(parseReference(value));
    } else {
      context.fields[key] = value;
    }
  }
  return context;
}

function parseReference(value) {
  const fields = {};
  const fieldPattern = /([a-zA-Z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match;
  while ((match = fieldPattern.exec(value))) {
    fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return { fields, type: fields.type || '' };
}

function pushMarkdownSegment(segments, text) {
  if (!text) return;
  const normalized = text.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  if (!normalized) return;
  segments.push({ text: normalized, type: 'markdown' });
}

function pageLabel(pageId) {
  const labels = {
    automations: 'Automations',
    chat: 'Chat',
    handoffs: 'Handoffs',
    issues: 'Issues',
    projects: 'Projects',
    runs: 'Runs',
    sessions: 'Sessions',
    work: 'Work',
  };
  return labels[pageId] || pageId || '当前页面';
}

function compactRunLabel(runId) {
  const match = /issue-(\d+)-attempt-(\d+)/.exec(String(runId || ''));
  if (match) return `Run #${match[1]} / Attempt ${match[2]}`;
  return compactIdentifier(runId, 'Run');
}

function compactWorkLabel(workId) {
  const match = /xw:work:issues:(\d+)/.exec(String(workId || ''));
  if (match) return `Work #${match[1]}`;
  return compactIdentifier(workId, 'Work');
}

function compactIdentifier(value, prefix) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `${prefix} ${text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-9)}` : text}`;
}

function copy(t, key, fallback, variables) {
  return typeof t === 'function' ? t(key, variables) : fallback;
}
