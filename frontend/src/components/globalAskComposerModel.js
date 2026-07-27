import { buildPiChatProjectSuggestions } from '../pages/piChatComposer.js';

export const GLOBAL_COMPOSER_PERMISSION_MODES = [
  { value: 'controlled', label: '受控操作' },
  { value: 'read_only', label: '只读' },
];

const PAGE_LABELS = {
  'ask-xuanwu': 'Ask Xuanwu',
  automations: 'Automations',
  'command-center': 'Command Center',
  connections: 'Connections',
  handoffs: 'Handoffs',
  issues: 'Work',
  projects: 'Projects',
  runs: 'Runs',
  settings: 'Settings',
  work: 'Work',
};

const MAX_WORK_SUGGESTIONS = 16;

export function isGlobalAskComposerVisible(page, pageContext = null) {
  return clean(page) !== 'ask-xuanwu'
    && clean(pageContext?.interaction_surface) !== 'provider-session';
}

export function buildGlobalComposerPageReference(route = {}, works = []) {
  const pageId = clean(route.currentPage) || 'command-center';
  const live = route.pageContext?.page_id === pageId ? route.pageContext : {};
  const issueId = positiveInteger(route.selectedIssueId);
  const issueWorkId = issueId ? `xw:work:issues:${issueId}` : '';
  const workId = clean(live.work_id) || issueWorkId;
  const work = workItems(works).find(item => item.id === workId);
  const projectId = clean(live.project_id)
    || clean(work?.owner?.project_id)
    || (pageId === 'issues' ? clean(route.filterProject) : '');
  const runId = clean(live.run_id) || (pageId === 'runs' ? clean(route.selectedRunId) : '');
  const sessionId = clean(live.session_id) || (pageId === 'runs' ? clean(route.selectedSessionId) : '');
  const handoffId = clean(live.handoff_id)
    || (pageId === 'handoffs' || pageId === 'work' ? clean(route.selectedHandoffId) : '');
  const routeRef = routeReference({ handoffId, issueId, pageId, projectId, runId, sessionId, workId });

  return {
    id: routeRef,
    key: `page:${routeRef}`,
    label: pageContextLabel(pageId, { handoffId, issueId, projectId, runId, sessionId, workId }),
    metadata: {
      page_id: pageId,
      project_id: projectId,
      provenance: 'runner_ui_page_context',
      route_ref: routeRef,
      run_id: runId,
      session_id: sessionId,
      work_id: workId,
    },
    type: 'page',
  };
}

export function syncGlobalComposerPageReference(references, prompt, nextPageReference) {
  const items = referenceItems(references);
  const explicit = items.filter(reference => reference.type !== 'page');
  if (clean(prompt) || explicit.length > 0) return items;
  return nextPageReference ? [nextPageReference] : [];
}

export function attachGlobalComposerPageReference(references, pageReference) {
  const explicit = referenceItems(references).filter(reference => reference.type !== 'page');
  return pageReference ? [pageReference, ...explicit] : explicit;
}

export function addGlobalComposerReference(references, reference) {
  const normalized = normalizeReference(reference);
  const current = referenceItems(references);
  if (!normalized) return current;
  if (current.some(item => referenceKey(item) === referenceKey(normalized))) return current;
  return [...current, normalized];
}

export function removeGlobalComposerReference(references, key) {
  return referenceItems(references).filter(reference => referenceKey(reference) !== key);
}

export function buildGlobalComposerSuggestions(projects = [], works = []) {
  return [
    ...buildPiChatProjectSuggestions(projects),
    ...workItems(works).slice(0, MAX_WORK_SUGGESTIONS).map(workSuggestion),
  ];
}

export function buildGlobalComposerReferenceDetails(references = [], projects = [], works = []) {
  const projectMap = new Map(projectItems(projects).map(project => [project.id, project]));
  const workMap = new Map(workItems(works).map(work => [work.id, work]));
  return referenceItems(references).map(reference => {
    if (reference.type === 'page') return pageReferenceDetail(reference);
    if (reference.type === 'project') return projectReferenceDetail(reference, projectMap);
    return workReferenceDetail(reference, workMap);
  });
}

export function buildGlobalComposerSubmission({ permissionMode = 'controlled', prompt = '', references = [] } = {}) {
  const normalizedReferences = referenceItems(references);
  const projectId = uniqueTargetProjectId(normalizedReferences);
  return {
    conversation: {
      project_id: projectId,
      title: 'New conversation',
    },
    message: {
      ...(permissionMode === 'read_only' ? { intent: 'review' } : {}),
      prompt: buildGlobalComposerPrompt(prompt, normalizedReferences, permissionMode),
      ...(projectId ? {
        target_project_id: projectId,
        target_project_source: 'request_project',
      } : {}),
    },
  };
}

export function buildGlobalComposerPrompt(prompt, references = [], permissionMode = 'controlled') {
  const contextLines = referenceItems(references).map(referencePromptLine).filter(Boolean);
  if (contextLines.length === 0 && permissionMode !== 'read_only') return prompt;
  return [
    '<runner_ui_context>',
    'source: runner_ui_global_composer',
    `permission_mode: ${permissionMode === 'read_only' ? 'read_only' : 'controlled'}`,
    'permission_note: this UI mode may only narrow deterministic runtime gates and never grants authority',
    ...contextLines,
    '</runner_ui_context>',
    '',
    prompt,
  ].join('\n');
}

function workSuggestion(work) {
  const issueId = issueIdFromWorkId(work.id);
  const labelId = issueId ? `#${issueId}` : compactId(work.id);
  return {
    description: `${clean(work.owner?.project_id) || 'project 未知'} · ${clean(work.status) || 'status 未知'}`,
    id: `global-work-${work.id}`,
    insertText: issueId ? `#${issueId}` : work.id,
    label: `@Work ${labelId} · ${clean(work.title) || 'Untitled Work'}`,
    reference: {
      id: work.id,
      label: `${labelId} ${clean(work.title) || 'Untitled Work'}`,
      metadata: { project_id: clean(work.owner?.project_id) },
      type: 'work',
    },
    searchText: `work ${work.id} ${work.title || ''} ${work.goal || ''} ${work.owner?.project_id || ''}`,
    trigger: '@',
  };
}

function pageReferenceDetail(reference) {
  return {
    ...reference,
    key: referenceKey(reference),
    message: '',
    status: 'ready',
    summary: `${reference.metadata?.provenance || 'runner_ui_page_context'} · ${reference.metadata?.route_ref || reference.id}`,
  };
}

function projectReferenceDetail(reference, projects) {
  const project = projects.get(reference.id);
  return {
    ...reference,
    key: referenceKey(reference),
    message: project ? '' : 'Project 不存在或未加载。',
    status: project ? 'ready' : 'error',
    summary: project ? `${project.name || project.id} · ${project.cwd || 'cwd 未知'}` : '缺少 project context',
  };
}

function workReferenceDetail(reference, works) {
  const work = works.get(reference.id);
  return {
    ...reference,
    key: referenceKey(reference),
    message: work ? '' : 'Work 不存在或未加载。',
    status: work ? 'ready' : 'error',
    summary: work ? `${work.owner?.project_id || 'project 未知'} · ${work.status || 'status 未知'}` : '缺少 Work context',
  };
}

function referencePromptLine(reference) {
  if (reference.type === 'page') {
    const metadata = reference.metadata || {};
    return contextLine('page_context', {
      page_id: metadata.page_id,
      project_id: metadata.project_id,
      provenance: metadata.provenance,
      route_ref: metadata.route_ref,
      run_id: metadata.run_id,
      session_id: metadata.session_id,
      work_id: metadata.work_id,
    });
  }
  if (reference.type === 'project') {
    return contextLine('project', { id: reference.id, provenance: 'explicit_composer_mention' });
  }
  if (reference.type === 'work') {
    return contextLine('work', {
      id: reference.id,
      project_id: reference.metadata?.project_id,
      provenance: 'explicit_composer_mention',
    });
  }
  return '';
}

function contextLine(type, fields) {
  const values = Object.entries(fields)
    .map(([key, value]) => [key, cleanContextValue(value)])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return values.length ? `reference: type=${type} ${values.join(' ')}` : '';
}

function uniqueTargetProjectId(references) {
  const ids = new Set(references.map(referenceProjectId).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : '';
}

function referenceProjectId(reference) {
  if (reference.type === 'project') return clean(reference.id);
  if (reference.type === 'work' || reference.type === 'page') return clean(reference.metadata?.project_id);
  return '';
}

function normalizeReference(reference) {
  const type = clean(reference?.type).toLowerCase();
  if (!['project', 'work'].includes(type)) return null;
  const id = clean(reference.id);
  if (!id) return null;
  return {
    id,
    label: clean(reference.label) || id,
    metadata: reference.metadata && typeof reference.metadata === 'object' ? { ...reference.metadata } : {},
    type,
  };
}

function referenceKey(reference) {
  return reference.key || `${reference.type || ''}:${reference.id || ''}`;
}

function routeReference({ handoffId, issueId, pageId, projectId, runId, sessionId, workId }) {
  return [
    pageId,
    issueId ? `issue:${issueId}` : '',
    workId ? `work:${workId}` : '',
    runId ? `run:${runId}` : '',
    sessionId ? `session:${sessionId}` : '',
    handoffId ? `handoff:${handoffId}` : '',
    projectId ? `project:${projectId}` : '',
  ].filter(Boolean).join('|');
}

function pageContextLabel(pageId, context) {
  const base = PAGE_LABELS[pageId] || pageId;
  if (context.runId) return `${base} · ${compactId(context.runId)}`;
  if (context.workId) return `${base} · ${compactId(context.workId)}`;
  if (context.issueId) return `${base} · #${context.issueId}`;
  if (context.handoffId) return `${base} · ${compactId(context.handoffId)}`;
  if (context.sessionId) return `${base} · ${compactId(context.sessionId)}`;
  if (context.projectId) return `${base} · @${context.projectId}`;
  return base;
}

function issueIdFromWorkId(value) {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(clean(value));
  return match ? Number.parseInt(match[1], 10) : null;
}

function compactId(value) {
  const text = clean(value);
  return text.length > 26 ? `${text.slice(0, 12)}…${text.slice(-8)}` : text;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function cleanContextValue(value) {
  return clean(value).slice(0, 240);
}

function projectItems(projects) {
  return Array.isArray(projects) ? projects.filter(project => clean(project?.id)) : [];
}

function workItems(works) {
  return Array.isArray(works) ? works.filter(work => clean(work?.id)) : [];
}

function referenceItems(references) {
  return Array.isArray(references) ? references.filter(Boolean) : [];
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
