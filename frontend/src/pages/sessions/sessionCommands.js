export const RUNNER_COMMANDS = {
  status: {
    name: 'status',
    label: '/status',
    title: '查询状态',
    actionLabel: '查询状态',
    description: '直接读取 runner / issue / system 状态，不发送给 Codex。',
  },
  issue: {
    name: 'issue',
    label: '/issue',
    title: '创建 issue draft',
    actionLabel: '创建 triage draft',
    description: '用当前 prompt 和 references 创建 triage issue，不会 todo/run。',
  },
  run: {
    name: 'run',
    label: '/run',
    title: '运行 issue',
    actionLabel: '确认 enqueue',
    description: '确认后 enqueue 指定 issue；取消不会修改状态。',
    requiresConfirmation: true,
  },
};

export function createSessionCommandState(command) {
  const name = normalizeCommandName(command?.name || command?.type);
  if (!RUNNER_COMMANDS[name]) return null;
  return { name, args: { ...(command.args || {}) }, target: command.target || null };
}

export function clearSessionCommandState() {
  return null;
}

export function commandDefinition(commandState) {
  return RUNNER_COMMANDS[normalizeCommandName(commandState?.name)] || null;
}

export function commandRequiresConfirmation(commandState) {
  return Boolean(commandDefinition(commandState)?.requiresConfirmation);
}

export function commandTargetSummary(commandState, { prompt = '', references = [], linkedIssues = [] } = {}) {
  const issueId = commandIssueId(commandState, { prompt, references, linkedIssues });
  if (!issueId) return '未选择 issue';
  const issue = [...references, ...linkedIssues].find((item) => String(item?.id) === String(issueId));
  return issue?.label || issue?.title ? `#${issueId} ${issue.label || issue.title}` : `#${issueId}`;
}

export function validateSessionCommand(commandState, context = {}) {
  const name = normalizeCommandName(commandState?.name);
  if (!RUNNER_COMMANDS[name]) return '请选择 command';
  if (name === 'run' && !commandIssueId(commandState, context)) {
    return '/run 需要选择 issue 或输入 #id';
  }
  if (name === 'issue' && !context.projectId && !projectIDFromReferences(context.references)) {
    return '/issue 需要选择 project';
  }
  if (name === 'issue' && !String(context.prompt || '').trim()) {
    return '/issue 需要先输入 draft 内容';
  }
  return '';
}

export function buildRunnerCommandRequest(commandState, context = {}, { confirmed = false } = {}) {
  const command = buildRunnerCommand(commandState, context, confirmed);
  const payload = { command };
  if (context.sessionId) payload.session_id = String(context.sessionId).trim();
  if (String(context.prompt || '').trim()) payload.prompt = String(context.prompt || '').trim();
  if (Array.isArray(context.references) && context.references.length) payload.references = context.references;
  return payload;
}

function buildRunnerCommand(commandState, context, confirmed) {
  const name = normalizeCommandName(commandState?.name);
  const args = { ...(commandState?.args || {}) };
  const issueId = commandIssueId(commandState, context);
  if (issueId) args.issue_id = Number(issueId);
  if (name === 'issue') applyIssueArgs(args, context);
  if (name === 'run' && confirmed) args.confirmed = true;
  return { name, args };
}

function applyIssueArgs(args, context) {
  const projectId = context.projectId || projectIDFromReferences(context.references);
  if (projectId) args.project_id = projectId;
  if (context.sessionId) args.source_session_id = context.sessionId;
  if (context.prompt) args.prompt = String(context.prompt).trim();
}

function commandIssueId(commandState, { prompt = '', references = [], linkedIssues = [] } = {}) {
  const explicit = commandState?.args?.issue_id || commandState?.args?.id || commandState?.target?.id;
  if (explicit) return cleanID(explicit);
  const ref = [...(references || []), ...(linkedIssues || [])].find((item) => item?.type === 'issue' || item?.id);
  if (ref?.id) return cleanID(ref.id);
  return cleanID(issueIDFromText(prompt));
}

function projectIDFromReferences(references = []) {
  const ref = references.find((item) => item?.type === 'project' && item?.id);
  return ref?.id || '';
}

function issueIDFromText(prompt) {
  const match = String(prompt || '').match(/(?:#|@issue\s+)(\d+)/i);
  return match?.[1] || '';
}

function cleanID(value) {
  const match = String(value || '').trim().match(/^\d+$/);
  return match ? match[0] : '';
}

function normalizeCommandName(value) {
  return String(value || '').replace(/^\//, '').trim().toLowerCase();
}
