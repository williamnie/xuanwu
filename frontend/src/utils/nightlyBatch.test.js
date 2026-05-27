import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeNightlyBatchForProject,
  canCreateNightlyBatch,
  currentNightlyItem,
  nextNightlyItem,
  selectedNightlyIssues,
} from './nightlyBatch.js';

test('selects nightly issues in runner claim order', () => {
  const issues = [
    { id: 2, project_id: 'demo', status: 'triage', priority: 0, created_at: '2026-01-02T00:00:00Z' },
    { id: 3, project_id: 'demo', status: 'triage', priority: 2, created_at: '2026-01-03T00:00:00Z' },
    { id: 1, project_id: 'demo', status: 'triage', priority: 0, created_at: '2026-01-01T00:00:00Z' },
  ];

  const selected = selectedNightlyIssues(issues, [1, 2, 3]);

  assert.deepEqual(selected.map(issue => issue.id), [3, 1, 2]);
  assert.equal(canCreateNightlyBatch(selected), true);
});

test('rejects creating a cross-project nightly batch', () => {
  assert.equal(canCreateNightlyBatch([
    { id: 1, project_id: 'demo' },
    { id: 2, project_id: 'other' },
  ]), false);
});

test('finds active batch and current next items', () => {
  const batch = activeNightlyBatchForProject([
    { id: 1, project_id: 'demo', status: 'done', items: [] },
    { id: 2, project_id: 'demo', status: 'active', items: [
      { issue_id: 7, status: 'current' },
      { issue_id: 8, status: 'pending' },
    ] },
  ], 'demo');

  assert.equal(batch.id, 2);
  assert.equal(currentNightlyItem(batch).issue_id, 7);
  assert.equal(nextNightlyItem(batch).issue_id, 8);
});
