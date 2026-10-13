export function editorDraft(work, projects) {
  return {
    agent_profile_id: work?.agent_profile_id || '',
    goal: work?.goal || '',
    project_id: work?.owner?.project_id || projects[0]?.id || '',
    status: 'triage',
    title: work?.title || '',
  };
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
