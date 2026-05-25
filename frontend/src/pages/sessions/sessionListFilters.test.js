import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_LIST_FILTER_RECENT,
  SESSION_LIST_FILTER_RUNNING,
  filterProjectSessionGroups,
  isSessionListFilterActive,
} from './sessionListFilters.js';

const groups = [
  {
    id: 'demo',
    name: 'Demo Project',
    cwd: '/repo/demo',
    sessions: [
      {
        id: 'codex:thread-alpha',
        provider_session_id: 'thread-alpha',
        name: 'Fix login flow',
        preview: 'Need auth patch',
        updatedAt: 2_000,
      },
      {
        id: 'codex:thread-beta',
        provider_session_id: 'thread-beta',
        name: 'Background worker',
        isRunning: true,
        updatedAt: 1_000,
      },
    ],
  },
  {
    id: 'ops',
    name: 'Ops Tools',
    cwd: '/repo/ops',
    sessions: [
      {
        id: 'codex:thread-gamma',
        sessionId: 'thread-gamma',
        preview: 'Deploy notes',
        status: { state: 'inProgress' },
        updatedAt: 1_950,
      },
      {
        id: 'codex:thread-old',
        provider_session_id: 'thread-old',
        preview: 'Old note',
        updatedAt: 10,
      },
    ],
  },
];

test('session search matches title, thread id, and project name', () => {
  assert.deepEqual(
    filterProjectSessionGroups(groups, { query: 'login' }).map((group) => group.sessions.map((session) => session.id)),
    [['codex:thread-alpha']],
  );
  assert.deepEqual(
    filterProjectSessionGroups(groups, { query: 'thread-gamma' }).map((group) => group.sessions.map((session) => session.id)),
    [['codex:thread-gamma']],
  );
  assert.deepEqual(
    filterProjectSessionGroups(groups, { query: 'Ops Tools' }).map((group) => group.sessions.map((session) => session.id)),
    [['codex:thread-gamma', 'codex:thread-old']],
  );
});

test('running filter keeps active sessions without changing group collapse identity', () => {
  const filtered = filterProjectSessionGroups(groups, { mode: SESSION_LIST_FILTER_RUNNING });

  assert.deepEqual(filtered.map((group) => group.id), ['demo', 'ops']);
  assert.deepEqual(filtered.map((group) => group.sessions.map((session) => session.id)), [
    ['codex:thread-beta'],
    ['codex:thread-gamma'],
  ]);
});

test('recent filter uses updated time and combines with search', () => {
  const filtered = filterProjectSessionGroups(groups, {
    mode: SESSION_LIST_FILTER_RECENT,
    query: 'ops',
    nowSeconds: 2_000,
    recentWindowSeconds: 100,
  });

  assert.deepEqual(filtered.map((group) => group.sessions.map((session) => session.id)), [
    ['codex:thread-gamma'],
  ]);
});

test('empty filter results return no groups for a clear list empty state', () => {
  assert.equal(isSessionListFilterActive({ query: 'missing' }), true);
  assert.deepEqual(filterProjectSessionGroups(groups, { query: 'missing' }), []);
});
