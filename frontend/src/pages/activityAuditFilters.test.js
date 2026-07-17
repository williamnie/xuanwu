import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityAuditFilterOptions,
  cleanActivityFilters,
  filterActivityAuditItems,
} from './activityAuditFilters.js';

const items = [
  { id: 'one', stage: 'Policy', status: 'recorded', decision: 'allowed' },
  { id: 'two', stage: 'Action', status: 'failed', decision: '' },
  { id: 'three', stage: 'Policy', status: 'recorded', decision: 'denied' },
];

test('filters activity audit nodes by stage, status, and decision without changing API scope', () => {
  assert.deepEqual(filterActivityAuditItems(items, { stage: 'Policy', status: 'recorded', decision: 'denied' }), [items[2]]);
  assert.deepEqual(filterActivityAuditItems(items, { status: 'failed' }), [items[1]]);
  assert.deepEqual(filterActivityAuditItems(items, {}), items);
});

test('derives stable audit filter options and trims server-side scope fields', () => {
  assert.deepEqual(activityAuditFilterOptions(items), {
    decisions: ['allowed', 'denied'],
    stages: ['Action', 'Policy'],
    statuses: ['failed', 'recorded'],
  });
  assert.deepEqual(cleanActivityFilters({ conversationId: ' conv-a ', limit: 100, source: ' fixture-cli ' }), {
    conversationId: 'conv-a',
    limit: 100,
    source: 'fixture-cli',
  });
});
