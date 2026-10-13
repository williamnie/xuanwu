import assert from 'node:assert/strict';
import test from 'node:test';

import { TASK_SCOPES, scopeCount } from './taskListModel.js';

test('task scopes cover every status exactly once, with cancelled only under all', () => {
  const statuses = TASK_SCOPES.flatMap(scope => scope.statuses);
  assert.deepEqual(statuses.sort(), ['done', 'failed', 'in_progress', 'needs_user', 'todo', 'triage']);
  assert.deepEqual(TASK_SCOPES.find(scope => scope.id === 'all').statuses, []);
});

test('scope counts come from the work summary and stay blank when unknown', () => {
  const counts = { todo: 2, in_progress: 1, triage: 1, needs_user: 0, failed: 3, done: 4, total: 12 };
  assert.equal(scopeCount(TASK_SCOPES[0], counts), 3);
  assert.equal(scopeCount(TASK_SCOPES[1], counts), 4);
  assert.equal(scopeCount(TASK_SCOPES[3], counts), 12);
  assert.equal(scopeCount(TASK_SCOPES[0], {}), '');
});
