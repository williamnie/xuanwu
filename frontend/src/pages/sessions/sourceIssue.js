import { localImagePathToAttachmentMarkdown } from '../../components/editor/attachments.js';

const SOURCE_TEXT_MAX_LENGTH = 2000;
const TITLE_EXCERPT_MAX_LENGTH = 42;

export function buildSessionIssuePayload(session, project, options = {}) {
  const sourceTurn = latestUserTurn(session);
  const selectedText = normalizeText(options.selectedText);
  const sourceExcerpt = truncateText(selectedText || sourceTurn.text || session?.preview || '', SOURCE_TEXT_MAX_LENGTH);
  const sessionId = sessionRef(session);
  const threadId = threadRef(session);
  const readableTitle = readableSessionTitle(session, project);

  return {
    title: sourceIssueTitle(sourceExcerpt, readableTitle),
    description: sourceIssueDescription({ sessionId, threadId, readableTitle, sourceExcerpt, selectedText }),
    project_id: project?.id || '',
    status: 'triage',
    source_session_id: threadId || sessionId,
    source_turn_id: sourceTurn.id,
    source_excerpt: sourceExcerpt,
  };
}

export function textFromUserContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (item.type === 'text' || item.type === 'input_text') return displayUserText(item.text || '');
    if (item.type === 'localImage') return localImagePathToAttachmentMarkdown(item.path);
    if (item.type === 'image' || item.type === 'input_image') return `![image](${item.url || item.image_url || ''})`;
    return '';
  }).filter(Boolean).join('\n\n');
}

export function displayUserText(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const trimmedStart = normalized.trimStart();
  const match = trimmedStart.match(/^Files mentioned by the user:\s*\n[\s\S]*?\nMy request for Codex:\s*/i);
  if (!match) return normalized;
  return trimmedStart.slice(match[0].length).trimStart();
}

export function latestUserTurn(session) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  for (let idx = turns.length - 1; idx >= 0; idx -= 1) {
    const text = userTurnText(turns[idx]);
    if (text) return { id: turns[idx]?.id || '', text };
  }
  return { id: '', text: normalizeText(session?.preview || '') };
}

function sourceIssueDescription({ sessionId, threadId, readableTitle, sourceExcerpt, selectedText }) {
  const contextHeading = selectedText ? '选中文本' : '最近上下文摘要';
  return [
    '## 来源 Session',
    `- Session ID: ${sessionId || '未知'}`,
    `- Thread ID: ${threadId || '未知'}`,
    `- Title: ${readableTitle || '未命名 Session'}`,
    '',
    `## ${contextHeading}`,
    sourceExcerpt || '（暂无可用上下文，请补充任务目标。）',
    '',
    '## 待 triage',
    '- 请基于上述 session 讨论补充明确任务目标、范围和验收标准。',
  ].join('\n');
}

function sourceIssueTitle(sourceExcerpt, readableTitle) {
  const base = firstNonEmptyLine(sourceExcerpt) || readableTitle || '从 Session 讨论创建 Issue';
  return `从 Session 创建：${truncateText(base, TITLE_EXCERPT_MAX_LENGTH)}`;
}

function userTurnText(turn) {
  for (const item of (turn?.items || [])) {
    if (item.type !== 'userMessage') continue;
    const text = normalizeText(textFromUserContent(item.content));
    if (text) return text;
  }
  return '';
}

function readableSessionTitle(session, project) {
  const name = normalizeText(typeof session?.name === 'string' ? session.name : '');
  return name || firstNonEmptyLine(session?.preview || '') || project?.name || projectNameFromPath(session?.cwd || session?.path || '');
}

function sessionRef(session) {
  return normalizeText(session?.id || providerSessionRef(session));
}

function threadRef(session) {
  return normalizeText(session?.provider_session_id || session?.sessionId || stripProviderPrefix(session?.id || ''));
}

function providerSessionRef(session) {
  const threadId = threadRef(session);
  const provider = normalizeText(session?.provider || 'codex');
  return threadId ? `${provider}:${threadId}` : '';
}

function stripProviderPrefix(value) {
  const text = normalizeText(value);
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

function firstNonEmptyLine(value) {
  return normalizeText(value).split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return trimmed.split(/[\\/]/).pop() || '';
}
