export function projectForSession(session, projectsById, projectsByCwd) {
  const projectId = String(session?.project_id || '').trim();
  if (projectId && projectsById.has(projectId)) return projectsById.get(projectId);
  return projectsByCwd.get(session?.cwd || '');
}
