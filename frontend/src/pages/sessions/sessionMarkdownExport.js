import { commandHistoryItems } from './sessionCommandHistory.js';
import { textFromUserContent } from './sourceIssue.js';
import { isRenderableToolItem, toolDisplayForItem } from './sessionTranscriptItems.js';

const BLOCK_MAX_CHARS = 6000;
const MARKDOWN_MAX_CHARS = 120000;
const TRANSCRIPT_ITEM_MAX_COUNT = 180;
const REDACTION = '[REDACTED]';

export function sessionToMarkdown(session, options = {}) {
  const warnings = [];
  const resume = buildSessionResumeCommand(session);
  const lines = [
    `# ${escapeHeading(readableSessionTitle(session, options.project))}`,
    '',
    '> Provider-neutral Markdown export generated from the currently loaded Runner session detail.',
    '',
    ...metadataLines(session, options, resume),
    '',
    ...issueLines(session),
    '',
    ...usageLines(session?.token_usage),
    '',
    ...commandHistoryLines(session?.command_history),
    '',
    ...transcriptLines(session, warnings),
  ];
  if (warnings.length > 0) {
    lines.push('', '## Export notes', ...warnings.map((warning) => `- ${warning}`));
  }
  return limitMarkdown(lines.join('\n'));
}

export function buildSessionResumeCommand(session) {
  const provider = normalizeText(session?.provider || 'codex').toLowerCase();
  const threadId = providerSessionId(session);
  if (provider !== 'codex') {
    return {
      action: 'runner',
      command: '',
      note: provider === 'claude'
        ? 'Continue or resume this Claude Agent SDK session in Runner; no unverified Claude CLI command is exported.'
        : `Continue this ${provider || 'unknown'} session in Runner; no verified provider CLI resume command is available.`,
    };
  }
  if (!threadId) {
    return {
      command: '',
      note: 'Codex resume command is unavailable because this session has no stable provider_session_id.',
    };
  }
  return {
    action: 'cli',
    command: `codex resume ${shellQuote(threadId)}`,
    note: 'Codex-only: requires a Codex CLI version that supports `codex resume <SESSION_ID>`.',
  };
}

export function markdownFilenameForSession(session) {
  const provider = normalizeText(session?.provider || 'codex').toLowerCase() || 'provider';
  const id = providerSessionId(session) || session?.id || 'session';
  return `${safeFilename(provider)}-session-${safeFilename(id)}.md`;
}
function metadataLines(session, options, resume) {
  const project = options.project || null;
  return [
    '## Metadata',
    `- Session ID: ${inlineValue(session?.id)}`,
    `- Provider: ${inlineValue(session?.provider || 'codex')}`,
    `- Provider session ID: ${inlineValue(providerSessionId(session))}`,
    `- Title: ${inlineValue(readableSessionTitle(session, project))}`,
    `- Project: ${inlineValue(project?.name || projectNameFromPath(session?.cwd || session?.path || ''))}`,
    `- CWD: ${inlineValue(session?.cwd || session?.path)}`,
    `- Status: ${inlineValue(formatStatus(session?.status, options.running))}`,
    `- Model: ${inlineValue(session?.model || session?.modelProvider)}`,
    `- Updated: ${inlineValue(formatTimestamp(session?.updatedAt))}`,
    '',
    '## Resume command',
    `- Resume path: ${resume.note}`,
    resume.command ? fencedCode('bash', resume.command) : '- Use the Runner transcript composer to continue this session.',
  ];
}
function issueLines(session) {
  const linked = session?.linked_issue;
  const sources = Array.isArray(session?.source_issues) ? session.source_issues : [];
  return [
    '## Linked issues',
    linked ? `- Linked: ${issueSummary(linked)}` : '- Linked: none',
    sources.length ? '- Source issues:' : '- Source issues: none',
    ...sources.map((issue) => `  - ${issueSummary(issue)}${sourceTurnSuffix(issue)}`),
  ];
}
function usageLines(usage) {
  const total = usage?.total_token_usage || {};
  const last = usage?.last_token_usage || {};
  if (!usage || (!total.total_tokens && !last.total_tokens)) {
    return ['## Token usage', '- No token usage captured.'];
  }
  return [
    '## Token usage',
    `- Total tokens: ${formatNumber(total.total_tokens)}`,
    `- Input / output: ${formatNumber(total.input_tokens)} / ${formatNumber(total.output_tokens)}`,
    `- Reasoning output: ${formatNumber(total.reasoning_output_tokens)}`,
    `- Last turn tokens: ${formatNumber(last.total_tokens)}`,
    usage.captured_at ? `- Captured at: ${inlineValue(usage.captured_at)}` : '',
  ].filter(Boolean);
}
function commandHistoryLines(history) {
  const items = commandHistoryItems(Array.isArray(history) ? history : []);
  if (items.length === 0) return ['## Command summary', '- No Session command history.'];
  return [
    '## Command summary',
    ...items.map((item) => `- ${inlineValue(item.title)}${item.error ? ` — Error: ${inlineValue(item.error)}` : summarySuffix(item)}`),
  ];
}
function transcriptLines(session, warnings) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  if (turns.length === 0) return ['## Transcript', '- Empty transcript.'];
  const lines = ['## Transcript'];
  let itemCount = 0;
  turns.forEach((turn, turnIndex) => {
    if (itemCount >= TRANSCRIPT_ITEM_MAX_COUNT) return;
    lines.push('', `### Turn ${turnIndex + 1}${turn?.id ? ` (${inlineValue(turn.id)})` : ''}`);
    for (const item of turn?.items || []) {
      if (itemCount >= TRANSCRIPT_ITEM_MAX_COUNT) break;
      const rendered = transcriptItemLines(item, warnings);
      if (rendered.length === 0) continue;
      lines.push('', ...rendered);
      itemCount += 1;
    }
  });
  if (itemCount >= TRANSCRIPT_ITEM_MAX_COUNT) {
    warnings.push(`Transcript item count exceeded ${TRANSCRIPT_ITEM_MAX_COUNT}; export was truncated.`);
  }
  return lines;
}
function transcriptItemLines(item, warnings) {
  if (item?.type === 'userMessage') {
    return messageLines('User', textFromUserContent(item.content), warnings, 'user message');
  }
  if (item?.type === 'agentMessage') {
    return messageLines('Assistant', item.text || '', warnings, 'assistant message');
  }
  if (isRenderableToolItem(item)) return toolLines(item, warnings);
  return [];
}
function messageLines(label, text, warnings, context) {
  const body = limitBlock(redactSensitiveText(text), warnings, context);
  return [`#### ${label}`, body || '_No text content._'];
}
function toolLines(item, warnings) {
  if (item.type === 'commandExecution') return commandToolLines(item, warnings);
  const display = toolDisplayForItem(item);
  if (!display) return [];
  const body = limitBlock(redactSensitiveText(display.body), warnings, display.title);
  return [`#### Tool: ${display.title}`, fencedCode('', body || 'No detail.')];
}
function commandToolLines(item, warnings) {
  const command = limitBlock(redactSensitiveText(item.command || item.text || ''), warnings, 'command');
  const output = item.text && item.text !== item.command
    ? limitBlock(redactSensitiveText(item.text), warnings, 'command output')
    : '';
  return [
    '#### Command',
    command ? fencedCode('bash', command) : '_Command text unavailable._',
    output ? fencedCode('', output) : '',
  ].filter(Boolean);
}
function issueSummary(issue) {
  const status = issue.status ? ` [${issue.status}]` : '';
  return `#${issue.id}${status} ${issue.title || 'Untitled'}`;
}
function sourceTurnSuffix(issue) {
  const parts = [];
  if (issue.source_turn_id) parts.push(`turn ${issue.source_turn_id}`);
  if (issue.source_excerpt) parts.push(truncateInline(issue.source_excerpt));
  return parts.length ? ` (${parts.join('; ')})` : '';
}
function summarySuffix(item) {
  const summary = item.error || item.summary || item.promptSummary || '';
  return summary ? ` — ${inlineValue(summary)}` : '';
}
function providerSessionId(session) {
  return normalizeText(session?.provider_session_id || session?.sessionId || stripProviderPrefix(session?.id));
}
function readableSessionTitle(session, project) {
  return firstNonEmpty(
    session?.name,
    firstLine(session?.preview),
    project?.name,
    projectNameFromPath(session?.cwd || session?.path),
    'Untitled session',
  );
}
function formatStatus(status, running) {
  if (running) return 'running';
  if (!status) return 'unknown';
  if (typeof status === 'string') {
    try { return formatStatus(JSON.parse(status), false); } catch { return status; }
  }
  if (typeof status === 'object') return firstNonEmpty(status.type, status.state, status.status, JSON.stringify(status));
  return String(status);
}
function formatTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '';
  const millis = number < 10000000000 ? number * 1000 : number;
  return new Date(millis).toISOString();
}

function redactSensitiveText(value) {
  return normalizeText(value)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s`'"\\]+/gi, `$1${REDACTION}`)
    .replace(secretAssignmentWithQuotesPattern(), `$1${REDACTION}$2`)
    .replace(secretAssignmentPattern(), `$1${REDACTION}`)
    .replace(/("(?:token|auth_token|access_token|api_key|secret|password|private_key)"\s*:\s*")[^"]+(")/gi, `$1${REDACTION}$2`)
    .replace(/(--(?:token|auth-token|access-token|api-key|password|secret|private-key)\s+)[^\s`'"\\]+/gi, `$1${REDACTION}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, REDACTION)
    .replace(/((?:Cookie|Set-Cookie|X-API-Key)\s*:\s*)[^\n]+/gi, `$1${REDACTION}`);
}

function secretAssignmentWithQuotesPattern() {
  return /((?:[A-Z0-9_]*)(?:TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN)(?:[A-Z0-9_]*)\s*=\s*["'])[^\n"']+(["'])/gi;
}

function secretAssignmentPattern() {
  return /((?:[A-Z0-9_]*)(?:TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN)(?:[A-Z0-9_]*)\s*=\s*)[^\s`'"\\]+/gi;
}

function limitBlock(value, warnings, context) {
  const text = normalizeText(value);
  if (text.length <= BLOCK_MAX_CHARS) return text;
  warnings.push(`${context} exceeded ${BLOCK_MAX_CHARS} characters and was truncated.`);
  return `${text.slice(0, BLOCK_MAX_CHARS)}\n\n[Truncated: ${text.length - BLOCK_MAX_CHARS} characters omitted]`;
}

function limitMarkdown(markdown) {
  if (markdown.length <= MARKDOWN_MAX_CHARS) return markdown;
  return [
    markdown.slice(0, MARKDOWN_MAX_CHARS),
    '',
    '## Export notes',
    `- Markdown exceeded ${MARKDOWN_MAX_CHARS} characters and was truncated.`,
  ].join('\n');
}

function fencedCode(language, value) {
  const text = String(value || '');
  const longest = Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1));
  const fence = '`'.repeat(longest);
  return `${fence}${language || ''}\n${text}\n${fence}`;
}

function shellQuote(value) {
  const text = normalizeText(value);
  return /^[A-Za-z0-9._:@/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function inlineValue(value, fallback = 'unknown') {
  const text = redactSensitiveText(value);
  return text || fallback;
}

function truncateInline(value) {
  const text = inlineValue(value, '');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function escapeHeading(value) {
  return inlineValue(value, 'Untitled session').replace(/^#+\s*/, '');
}

function projectNameFromPath(cwd) {
  const trimmed = normalizeText(cwd).replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return trimmed.split(/[\\/]/).pop() || '';
}

function stripProviderPrefix(value) {
  const text = normalizeText(value);
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

function safeFilename(value) {
  return normalizeText(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

function firstLine(value) {
  return normalizeText(value).split('\n').find((line) => line.trim()) || '';
}

function firstNonEmpty(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US').format(number) : '0';
}
