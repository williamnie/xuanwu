import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_SESSION_PAGE_SIZE,
  nextProjectSessionVisibleCount,
  projectSessionMoreState,
  projectSessionVisibleCount,
  visibleProjectSessions,
} from './projectSessionPagination.js';

const sessions = Array.from({ length: 7 }, (_, index) => ({ id: `session-${index + 1}` }));

test('project sessions default to the latest five visible rows', () => {
  assert.equal(PROJECT_SESSION_PAGE_SIZE, 5);
  assert.deepEqual(visibleProjectSessions(sessions).map((session) => session.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
  ]);
});

test('project load more reveals the next loaded page without hiding existing rows', () => {
  const current = projectSessionVisibleCount('demo', {});
  const next = nextProjectSessionVisibleCount(current, sessions.length);

  assert.equal(current, 5);
  assert.equal(next, 7);
  assert.deepEqual(visibleProjectSessions(sessions, next).map((session) => session.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-6',
    'session-7',
  ]);
});

test('project more state only reveals loaded rows beyond the visible window', () => {
  assert.deepEqual(projectSessionMoreState(5, 5), {
    hiddenLoadedCount: 0,
    canRevealLoaded: false,
  });
  assert.deepEqual(projectSessionMoreState(7, 5), {
    hiddenLoadedCount: 2,
    canRevealLoaded: true,
  });
});
