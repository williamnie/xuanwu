export const LAST_TASK_PROJECT_KEY = 'xuanwu-last-task-project';

// 新建时项目取：打开时的上下文项目 → 上次使用的项目 → 第一个项目；编辑时始终沿用任务原项目。
export function editorDraft(work, projects, { initialProject = '', lastProject = '' } = {}) {
  const known = id => Boolean(id) && projects.some(project => project.id === id);
  const projectId = work?.owner?.project_id
    || (known(initialProject) ? initialProject : known(lastProject) ? lastProject : projects[0]?.id || '');
  return {
    agent_profile_id: work?.agent_profile_id || '',
    goal: work?.goal || '',
    project_id: projectId,
    status: 'triage',
    title: work?.title || '',
  };
}

export function profilePreviewText(preview) {
  const tool = preview.provider || '编程工具';
  const model = preview.model || '默认模型';
  const source = preview.source === 'work' ? '来自所选预设' : preview.source === 'project_default' ? '来自项目默认预设' : '来自项目设置';
  return `将使用：${tool} · ${model}（${source}）`;
}

export function effectiveProfilePreview(explicitProfileId, project, profiles) {
  const explicit = profiles.find(profile => profile.id === explicitProfileId);
  if (explicit) return { ...explicit, source: 'work' };
  const inherited = profiles.find(profile => profile.id === project?.default_agent_profile_id);
  if (inherited) return { ...inherited, source: 'project_default' };
  return {
    id: '',
    model: project?.model || '',
    name: '',
    provider: project?.provider || '',
    source: 'project_provider',
  };
}

const PROFILE_SOURCE_LABELS = {
  project_default: '项目默认预设',
  project_provider: '项目默认编程工具',
  strategy: '自动匹配的预设',
  work: '任务指定',
};

export function workProfileSummary(work, latestRun) {
  const effective = work?.effective_agent_profile || {};
  const source = effective.source || 'project_provider';
  return {
    selection: work?.agent_profile_id || '跟随项目设置',
    effectiveProfile: effective.name || effective.id || '不使用预设',
    effectiveProvider: work?.effective_provider || effective.provider || 'unknown',
    effectiveModel: effective.model || '编程工具默认',
    source,
    sourceLabel: PROFILE_SOURCE_LABELS[source] || source,
    runProvider: latestRun?.provider || '尚未执行',
  };
}
