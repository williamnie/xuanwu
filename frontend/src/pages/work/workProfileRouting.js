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

export function workProfileSummary(work, latestRun) {
  const effective = work?.effective_agent_profile || {};
  return {
    selection: work?.agent_profile_id || '继承项目默认',
    effectiveProfile: effective.name || effective.id || 'Project provider fallback',
    effectiveProvider: work?.effective_provider || effective.provider || 'unknown',
    effectiveModel: effective.model || 'provider default',
    source: effective.source || 'project_provider',
    runProvider: latestRun?.provider || 'No Run yet',
  };
}
