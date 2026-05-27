import { sortIssuesForNightlyQueue } from './issueSort.js';

export function selectedNightlyIssues(triageIssues, selectedIds) {
  return sortIssuesForNightlyQueue(
    triageIssues.filter(issue => selectedIds.includes(issue.id))
  );
}

export function canCreateNightlyBatch(issues) {
  if (issues.length === 0) return false;
  return new Set(issues.map(issue => issue.project_id)).size === 1;
}

export function activeNightlyBatchForProject(batches, projectId = '') {
  const scoped = batches.filter(batch => !projectId || batch.project_id === projectId);
  return scoped.find(batch => batch.status === 'active' || batch.status === 'paused') || scoped[0] || null;
}

export function currentNightlyItem(batch) {
  return batch?.items?.find(item => item.status === 'current') || null;
}

export function nextNightlyItem(batch) {
  return batch?.items?.find(item => item.status === 'pending') || null;
}
