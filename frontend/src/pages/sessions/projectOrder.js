export function moveProjectId(ids, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return ids;
  const fromIndex = ids.indexOf(sourceId);
  const toIndex = ids.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return ids;
  const next = ids.slice();
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function orderedProjectsAfterMove(projects, sourceId, targetId) {
  const currentIds = projects.map((project) => project.id);
  const ids = moveProjectId(currentIds, sourceId, targetId);
  if (ids === currentIds) return projects;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return ids.map((id) => projectById.get(id)).filter(Boolean);
}
