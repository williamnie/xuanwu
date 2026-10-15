import assert from 'node:assert/strict';
import test from 'node:test';
import { appHashForRoute, appRouteFromHash } from './appRouteModel.js';
import { handoffRouteFromHash } from './pages/handoffPageModel.js';

const workId = 'xw:work:issues:42';
const handoffId = 'xw:handoff:derived:42';
const query = '?project=project%2Fone&source=github&runId=run-42&unknown=kept-in-url';

test('Handoff query regression: old and new task delivery paths retain identity and task context', () => {
  for (const page of ['work', 'tasks']) {
    const hash = `#/${page}/${encodeURIComponent(workId)}/delivery/${encodeURIComponent(handoffId)}${query}`;
    assert.deepEqual(handoffRouteFromHash(hash), { page: 'tasks', workId, handoffId });
    for (const workBoardEnabled of [true, false]) {
      const route = appRouteFromHash(hash, { workBoardEnabled });
      assert.equal(route.currentPage, 'tasks');
      assert.equal(route.selectedWorkId, workId);
      assert.equal(route.selectedHandoffId, handoffId);
      assert.equal(route.filterProject, 'project/one');
      assert.equal(route.taskSource, 'github');
      assert.equal(route.selectedRunId, 'run-42');
      assert.deepEqual(appRouteFromHash(appHashForRoute(route), { workBoardEnabled }), route);
    }
  }
});

test('standalone Handoff accepts queries without becoming a task or accepting malformed IDs', () => {
  const hash = `#/handoffs/${encodeURIComponent(handoffId)}${query}`;
  assert.deepEqual(handoffRouteFromHash(hash), { page: 'handoffs', handoffId });
  const route = appRouteFromHash(hash);
  assert.equal(route.currentPage, 'handoffs');
  assert.equal(route.selectedHandoffId, handoffId);
  assert.equal(route.selectedWorkId, '');
  assert.deepEqual(appRouteFromHash(appHashForRoute(route)), route);
  for (const path of ['#/handoffs/%', '#/handoffs/not-an-id', '#/work/invalid/delivery/invalid', '#/tasks/invalid/delivery/invalid']) {
    assert.equal(handoffRouteFromHash(`${path}?project=one`), null);
  }
});
