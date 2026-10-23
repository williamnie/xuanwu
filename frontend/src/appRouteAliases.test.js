import assert from 'node:assert/strict';
import test from 'node:test';
import { appHashForRoute, appRouteFromHash, DEFAULT_APP_ROUTE } from './appRouteModel.js';
import { productNavPageForRoute } from './pages/assistantModules.js';
import { buildGlobalComposerPageReference } from './components/globalAskComposerModel.js';

test('canonical inbox/tasks routes and their permanent aliases resolve to identical state', () => {
  assert.equal(DEFAULT_APP_ROUTE.currentPage, 'inbox');
  for (const [legacy, canonical] of [['command-center', 'inbox'], ['work', 'tasks']]) {
    for (const query of ['', '?project=one&source=github&scope=attention', '?workId=xw%3Awork%3Aissues%3A42&runId=run-42']) {
      assert.deepEqual(appRouteFromHash(`#/${legacy}${query}`), appRouteFromHash(`#/${canonical}${query}`));
    }
    assert.equal(appHashForRoute({ currentPage: legacy }), `#/${canonical}`);
    assert.equal(appHashForRoute({ currentPage: canonical }), `#/${canonical}`);
    assert.equal(productNavPageForRoute(legacy), canonical);
    assert.equal(productNavPageForRoute(canonical), canonical);
  }
  assert.equal(productNavPageForRoute('automations'), 'tasks');
});

test('old and new delivery URLs resolve to the same task route', () => {
  const workId = 'xw:work:issues:42';
  const handoffId = 'xw:handoff:derived:42';
  const routes = ['work', 'tasks'].map(page => appRouteFromHash(
    `#/${page}/${encodeURIComponent(workId)}/delivery/${encodeURIComponent(handoffId)}`,
  ));
  assert.deepEqual(routes[0], routes[1]);
  assert.equal(routes[1].currentPage, 'tasks');
  assert.equal(routes[1].selectedWorkId, workId);
  assert.equal(routes[1].selectedHandoffId, handoffId);
  assert.equal(appHashForRoute(routes[1]), `#/tasks/${encodeURIComponent(workId)}/delivery/${encodeURIComponent(handoffId)}`);
});

test('page references use canonical route IDs while retaining historical context labels', () => {
  for (const [legacy, canonical] of [['command-center', 'inbox'], ['work', 'tasks']]) {
    const oldReference = buildGlobalComposerPageReference({ currentPage: legacy });
    const reference = buildGlobalComposerPageReference(appRouteFromHash(`#/${legacy}`));
    assert.equal(reference.metadata.page_id, canonical);
    assert.equal(reference.metadata.route_ref, canonical);
    assert.equal(reference.label, oldReference.label);
  }
});
