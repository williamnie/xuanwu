export const PROJECT_REQUIRED_MESSAGE = '需要先选择项目';

export function canCreateSession({ projectId, cwd, prompt }) {
  if (!String(prompt || '').trim()) {
    return { ok: false, reason: 'empty_prompt' };
  }
  if (!String(projectId || '').trim() || !String(cwd || '').trim()) {
    return { ok: false, reason: 'missing_project', message: PROJECT_REQUIRED_MESSAGE };
  }
  return { ok: true };
}

export function resolveLastSessionProject(projects, lastProjectId) {
  if (!Array.isArray(projects) || !lastProjectId) return null;
  return projects.find((project) => project.id === lastProjectId) || null;
}
