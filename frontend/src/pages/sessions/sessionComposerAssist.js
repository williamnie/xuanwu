const MAX_ISSUE_REFERENCES = 12;

export function buildSessionComposerSuggestions({ issues = [], currentProject = null, linkedIssues = [], capabilities = {}, pathReferences = {} } = {}) {
  return [
    buildStatusCommand(linkedIssues),
    buildIssueCommand(currentProject),
    buildRunCommand(linkedIssues),
    ...capabilityRequestSuggestions(capabilities.skills, 'skill'),
    ...capabilityRequestSuggestions(capabilities.plugins, 'plugin'),
    ...pathReferenceSuggestions(pathReferences.files, 'file'),
    ...pathReferenceSuggestions(pathReferences.folders, 'folder'),
    ...issueReferenceSuggestions(issues),
    ...capabilityReferenceSuggestions(capabilities.skills, 'skill'),
    ...capabilityReferenceSuggestions(capabilities.plugins, 'plugin'),
  ];
}

export function issueCommandPrompt(project = null) {
  const projectLine = project ? `项目：${projectLabel(project)}\n\n` : '';
  return `${projectLine}请把下面内容整理为一个 codex-issue-runner issue：\n\n## 背景/问题\n\n## 目标\n\n## 范围\n\n## 验收\n\n## 验证方式\n`;
}

export function statusCommandPrompt(linkedIssues = []) {
  const refs = linkedIssues.map(issueReferenceText).filter(Boolean).join('、');
  const targetLine = refs ? `关联 issue：${refs}\n\n` : '';
  return `${targetLine}请查询当前 linked issue / runner 状态，并总结：\n- 当前状态\n- 最近日志或错误\n- 下一步建议\n`;
}

function projectLabel(project) {
  const id = cleanInline(project?.id);
  const name = cleanInline(project?.name) || id || '未命名项目';
  return id && id !== name ? `${name} (${id})` : name;
}

export function issueReferenceText(issue) {
  const id = cleanInline(issue?.id);
  if (!id) return '';
  const title = cleanInline(issue?.title) || 'Untitled issue';
  return `#${id} ${title}`;
}

function buildIssueCommand(currentProject) {
  return {
    id: 'command-issue',
    trigger: '/',
    label: '/issue',
    description: '创建 triage issue draft，不会直接运行',
    insertText: '',
    command: { name: 'issue', args: issueCommandArgs(currentProject) },
    searchText: 'issue create 创建 任务 结构化',
  };
}

function buildStatusCommand(linkedIssues) {
  return {
    id: 'command-status',
    trigger: '/',
    label: '/status',
    description: '直接查询 linked issue / runner 状态',
    insertText: '',
    command: { name: 'status', args: issueArgFromLinked(linkedIssues) },
    searchText: 'status 状态 runner linked issue 查询',
  };
}


function buildRunCommand(linkedIssues) {
  return {
    id: 'command-run',
    trigger: '/',
    label: '/run',
    description: '确认后 enqueue 指定 issue',
    insertText: '',
    command: { name: 'run', args: issueArgFromLinked(linkedIssues), requires_confirmation: true },
    searchText: 'run enqueue 运行 issue 确认',
  };
}

function issueCommandArgs(currentProject) {
  const id = cleanInline(currentProject?.id);
  return id ? { project_id: id } : {};
}

function issueArgFromLinked(linkedIssues = []) {
  const id = cleanInline(linkedIssues.find((issue) => issue?.id)?.id);
  return id ? { issue_id: Number(id) } : {};
}

function issueReferenceSuggestions(issues) {
  return issues.slice(0, MAX_ISSUE_REFERENCES).map((issue) => ({
    id: `issue-${issue.id}`,
    trigger: '@',
    label: issueReferenceText(issue),
    description: [issue.status, issue.project_id].filter(Boolean).join(' · '),
    insertText: issueReferenceText(issue),
    reference: {
      type: 'issue',
      id: cleanInline(issue.id),
      label: cleanInline(issue.title) || `#${issue.id}`,
      metadata: { project_id: cleanInline(issue.project_id), status: cleanInline(issue.status) },
    },
    searchText: `issue ${issue.id || ''} #${issue.id || ''} ${issue.title || ''} ${issue.status || ''} ${issue.project_id || ''}`,
  }));
}

function capabilityReferenceSuggestions(items = [], type) {
  return capabilityItems(items).map((item) => ({
    id: `${type}-${item.name}`,
    trigger: '@',
    label: `@${type} ${item.name}`,
    description: capabilityDescription(item, '附加能力说明上下文'),
    insertText: '',
    reference: capabilityReference(item, type, 'context'),
    searchText: capabilitySearchText(item, type),
  }));
}

function pathReferenceSuggestions(items = [], type) {
  return pathReferenceItems(items).map((item) => ({
    id: `${type}-${item.path}`,
    trigger: '@',
    label: `@${type} ${item.path}`,
    description: pathReferenceDescription(item, type),
    insertText: '',
    reference: pathReference(item, type),
    searchText: `${type} @${type} ${item.path}`,
  }));
}

function pathReference(item, type) {
  const metadata = type === 'folder'
    ? { file_count: Number(item.file_count || 0) }
    : { size_bytes: Number(item.size_bytes || 0) };
  return { type, path: cleanInline(item.path), label: cleanInline(item.path), metadata };
}

function pathReferenceItems(items = []) {
  return Array.isArray(items) ? items.filter((item) => cleanInline(item?.path)).slice(0, 40) : [];
}

function pathReferenceDescription(item, type) {
  if (type === 'folder') return `${Number(item.file_count || 0)} 个文件`;
  return `${Number(item.size_bytes || 0)} bytes`;
}

function capabilityRequestSuggestions(items = [], type) {
  return capabilityItems(items).map((item) => ({
    id: `command-${type}-${item.name}`,
    trigger: '/',
    label: `/${type} ${item.name}`,
    description: capabilityRequestDescription(item),
    insertText: '',
    reference: capabilityReference(item, type, 'request'),
    searchText: `${type} /${type} request 请求 使用 ${item.name} ${item.summary || ''}`,
  }));
}

function capabilityReference(item, type, intent) {
  return {
    type,
    name: cleanInline(item.name),
    label: cleanInline(item.name),
    metadata: { summary: cleanInline(item.summary), intent },
  };
}

function capabilityItems(items = []) {
  return Array.isArray(items) ? items.filter((item) => cleanInline(item?.name)).slice(0, 12) : [];
}

function capabilityDescription(item, fallback) {
  return cleanInline(item.summary) || fallback;
}

function capabilityRequestDescription(item) {
  const summary = cleanInline(item.summary);
  return summary ? `请求使用该能力 · ${summary}` : '请求使用该能力；不强制启用 tool';
}

function capabilitySearchText(item, type) {
  return `${type} @${type} ${item.name || ''} ${item.summary || ''}`;
}

function cleanInline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
