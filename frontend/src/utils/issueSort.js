export function sortIssuesByIdDesc(issues) {
  return [...issues].sort((left, right) => Number(right.id) - Number(left.id));
}


export function sortIssuesForNightlyQueue(issues) {
  return [...issues].sort((left, right) => {
    const priorityDiff = Number(right.priority || 0) - Number(left.priority || 0);
    if (priorityDiff !== 0) return priorityDiff;
    const createdDiff = Date.parse(left.created_at || '') - Date.parse(right.created_at || '');
    if (!Number.isNaN(createdDiff) && createdDiff !== 0) return createdDiff;
    return Number(left.id) - Number(right.id);
  });
}
