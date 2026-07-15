const MAX_PROJECT_SUGGESTIONS = 12;

export function buildPiChatProjectSuggestions(projects = []) {
  return projectItems(projects).map((project) => ({
    id: `pi-project-${project.id}`,
    trigger: '@',
    label: `@${project.name || project.id}`,
    description: project.cwd || '把本次 Supervisor 对话绑定到这个项目',
    insertText: `@${project.id}`,
    reference: {
      type: 'project',
      id: cleanText(project.id),
      label: cleanText(project.name) || cleanText(project.id),
      metadata: { cwd: cleanText(project.cwd) },
    },
    searchText: `project ${project.id || ''} ${project.name || ''} ${project.cwd || ''}`,
  }));
}

export function buildPiChatReferenceDetails(references = [], projects = []) {
  const projectMap = new Map(projectItems(projects).map((project) => [project.id, project]));
  return referenceItems(references).map((reference) => projectReferenceDetail(reference, projectMap));
}

function projectReferenceDetail(reference, projectMap) {
  const project = projectMap.get(reference.id);
  const ready = Boolean(project);
  return {
    ...reference,
    key: referenceKey(reference),
    status: ready ? 'ready' : 'error',
    message: ready ? '' : 'Project 不存在或未加载。',
    summary: ready ? `${project.name || project.id} · ${project.cwd || 'cwd 未知'}` : '缺少 project context',
  };
}

function projectItems(projects) {
  return Array.isArray(projects)
    ? projects.filter((project) => cleanText(project?.id)).slice(0, MAX_PROJECT_SUGGESTIONS)
    : [];
}

function referenceItems(references) {
  return Array.isArray(references)
    ? references.filter((reference) => reference?.type === 'project' && cleanText(reference.id))
    : [];
}

function referenceKey(reference) {
  return `${reference?.type || ''}:${reference?.id || ''}`;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
