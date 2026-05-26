const MAX_PROJECT_REFERENCES = 8;
const MAX_ISSUE_REFERENCES = 12;

export function buildSessionComposerSuggestions({ projects = [], issues = [], currentProject = null, linkedIssues = [] } = {}) {
  return [
    buildStatusCommand(linkedIssues),
    buildIssueCommand(currentProject),
    buildRunCommand(linkedIssues),
    ...projectReferenceSuggestions(projects),
    ...issueReferenceSuggestions(issues),
  ];
}

export function issueCommandPrompt(project = null) {
  const projectLine = project ? `项目：${projectReferenceText(project)}\n\n` : '';
  return `${projectLine}请把下面内容整理为一个 codex-issue-runner issue：\n\n## 背景/问题\n\n## 目标\n\n## 范围\n\n## 验收\n\n## 验证方式\n`;
}

export function statusCommandPrompt(linkedIssues = []) {
  const refs = linkedIssues.map(issueReferenceText).filter(Boolean).join('、');
  const targetLine = refs ? `关联 issue：${refs}\n\n` : '';
  return `${targetLine}请查询当前 linked issue / runner 状态，并总结：\n- 当前状态\n- 最近日志或错误\n- 下一步建议\n`;
}

export function projectReferenceText(project) {
  const id = cleanInline(project?.id);
  const name = cleanInline(project?.name) || id || '未命名项目';
  return id ? `@project:${id} ${name}` : `@project ${name}`;
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

function projectReferenceSuggestions(projects) {
  return projects.slice(0, MAX_PROJECT_REFERENCES).map((project) => ({
    id: `project-${project.id}`,
    trigger: '@',
    label: `@project ${cleanInline(project.name) || project.id}`,
    description: cleanInline(project.cwd) || '已注册 project',
    insertText: projectReferenceText(project),
    reference: {
      type: 'project',
      id: cleanInline(project.id),
      label: cleanInline(project.name) || cleanInline(project.id),
      metadata: { cwd: cleanInline(project.cwd) },
    },
    searchText: `project ${project.id || ''} ${project.name || ''} ${project.cwd || ''}`,
  }));
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

function cleanInline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
