import assert from 'node:assert/strict';
import test from 'node:test';

import { sortIssuesByIdDesc } from './issueSort.js';

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
