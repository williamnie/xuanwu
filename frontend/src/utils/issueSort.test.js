import assert from 'node:assert/strict';
import test from 'node:test';

import { sortIssuesByIdDesc, sortIssuesForNightlyQueue } from './issueSort.js';

test('sorts issues by id descending without mutating input', () => {
  const issues = [
    { id: 16, status: 'triage' },
    { id: 24, status: 'triage' },
    { id: 23, status: 'triage' },
  ];

  const sorted = sortIssuesByIdDesc(issues);

  assert.deepEqual(sorted.map(issue => issue.id), [24, 23, 16]);
  assert.deepEqual(issues.map(issue => issue.id), [16, 24, 23]);
});


test('sorts nightly queue by runner claim order', () => {
  const issues = [
    { id: 2, priority: 0, created_at: '2026-01-02T00:00:00Z' },
    { id: 3, priority: 2, created_at: '2026-01-03T00:00:00Z' },
    { id: 1, priority: 0, created_at: '2026-01-01T00:00:00Z' },
  ];

  const sorted = sortIssuesForNightlyQueue(issues);

  assert.deepEqual(sorted.map(issue => issue.id), [3, 1, 2]);
  assert.deepEqual(issues.map(issue => issue.id), [2, 3, 1]);
});

test('sorts nightly queue ties by id ascending', () => {
  const issues = [
    { id: 9, priority: 1, created_at: '2026-01-01T00:00:00Z' },
    { id: 7, priority: 1, created_at: '2026-01-01T00:00:00Z' },
  ];

  const sorted = sortIssuesForNightlyQueue(issues);

  assert.deepEqual(sorted.map(issue => issue.id), [7, 9]);
});
