import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  ACTIVITY_ID_FILTER_KEYS,
  DEFAULT_ACTIVITY_FILTERS,
  activityAuditFilterOptions,
  cleanActivityFilters,
  filterActivityAuditItems,
} from './activityAuditFilters.js';

test('ID filters stay discoverable together and expand when a value is present', () => {
  assert.deepEqual(ACTIVITY_ID_FILTER_KEYS, ['conversationId', 'inboxItemId', 'issueId', 'proposalId']);
  assert.deepEqual(ACTIVITY_ID_FILTER_KEYS, Object.keys(DEFAULT_ACTIVITY_FILTERS).filter(key => key.endsWith('Id')));
  const source = readFileSync(new URL('./ActivityTimelinePanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /<details[^>]*activity-id-filters[^>]*open=\{hasIdFilter\}/);
  assert.match(source, /'Find by ID' : '按 ID 查找'/);
  assert.match(source, /ACTIVITY_ID_FILTER_KEYS\.map/);
  assert.match(source, /hasIdFilter \? ` \(\$\{idFilterCount\}\)`/);
});

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
