export const PROJECT_REQUIRED_MESSAGE = '需要先选择项目';
export const SESSIONS_UNSUPPORTED_MESSAGE = '所选 provider 不支持 Sessions，请改用 Issue 执行';

export function canCreateSession({ projectId, cwd, prompt, selectedProject, references = [] }) {
  if (!String(prompt || '').trim() && (!Array.isArray(references) || references.length === 0)) {
    return { ok: false, reason: 'empty_prompt' };
  }
  if (!String(projectId || '').trim() || !String(cwd || '').trim()) {
    return { ok: false, reason: 'missing_project', message: PROJECT_REQUIRED_MESSAGE };
  }
  if (!selectedProject) {
    return { ok: false, reason: 'missing_project', message: PROJECT_REQUIRED_MESSAGE };
  }
  if (selectedProject && !providerSupportsSessions(selectedProject)) {
    return { ok: false, reason: 'unsupported_provider', message: SESSIONS_UNSUPPORTED_MESSAGE };
  }
  return { ok: true };
}

export function resolveLastSessionProject(projects, lastProjectId) {
  if (!Array.isArray(projects) || !lastProjectId) return null;
  return projects.find((project) => project.id === lastProjectId && providerSupportsSessions(project)) || null;
}

export function providerSupportsSessions(project) {
  return Array.isArray(project?.provider_capabilities) && project.provider_capabilities.includes('sessions');
}
