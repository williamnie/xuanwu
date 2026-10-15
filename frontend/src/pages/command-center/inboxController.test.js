import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxController, inboxInitialState } from './inboxController.js';
import { inboxIsEmpty } from './taskRequestsModel.js';

const item = key => ({ key, source: 'attention' });
const page = (keys, extra = {}) => ({ contract: 'xw.command-center.inbox.v1', items: keys.map(item), total: keys.length, counts: { attention: keys.length }, complete: true, failed_sources: [], next_cursor: null, ...extra });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const requests = [], timers = new Map(), states = [];
  let state = inboxInitialState(), timerID = 0;
  const controller = createInboxController({
    fetchPage: (params, options) => new Promise((resolve, reject) => {
      assert.equal(requests.filter(request => !request.done && !request.signal.aborted).length, 0, 'only one live inbox request');
      const request = { params, signal: options.signal, done: false, resolve: value => { request.done = true; resolve(value); }, reject: error => { request.done = true; reject(error); } };
      requests.push(request);
    }),
    onChange: next => { state = next; states.push(next); },
    setTimer: (fn, delay) => { assert.equal(delay, 500); timers.set(++timerID, fn); return timerID; },
    clearTimer: id => timers.delete(id),
  });
  return { controller, requests, states, get state() { return state; }, get timers() { return timers.size; }, fire: () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); } };
}

test('Inbox appends opaque cursor pages, de-duplicates keys and refreshes from the first page', async () => {
  const f = fixture();
  const first = f.controller.refresh(); f.requests[0].resolve(page(['a', 'b'], { total: 3, next_cursor: 'opaque+/=' })); await first;
  const more = f.controller.loadMore();
  assert.deepEqual(f.requests[1].params, { limit: 20, cursor: 'opaque+/=' });
  await f.controller.loadMore(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(page(['b', 'c'], { total: 3 })); await more;
  assert.deepEqual(f.state.items.map(item => item.key), ['a', 'b', 'c']);
  await f.controller.loadMore(); assert.equal(f.requests.length, 2);
  const refresh = f.controller.refresh(); assert.deepEqual(f.requests[2].params, { limit: 20 });
  f.requests[2].resolve(page(['new'])); await refresh;
  assert.deepEqual(f.state.items.map(item => item.key), ['new']);
});

test('events immediately invalidate a pending page, debounce bursts and discard late success before and after refresh', async () => {
  const f = fixture();
  const first = f.controller.refresh(); f.requests[0].resolve(page(['a'], { next_cursor: 'next' })); await first;
  const more = f.controller.loadMore();
  f.controller.event({ type: 'issue.updated' });
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(page(['late'])); await more;
  assert.deepEqual(f.state.items.map(item => item.key), ['a']);
  assert.equal(f.state.loading, true);
  for (const type of ['approval.resolved', 'pi.action.updated', 'attention.changed']) f.controller.event({ type });
  f.controller.event({ type: 'usage.updated' });
  assert.equal(f.timers, 1); assert.equal(f.requests.length, 2);
  await f.controller.loadMore(); assert.equal(f.requests.length, 2);
  f.fire(); assert.deepEqual(f.requests[2].params, { limit: 20 });
  f.controller.event({ type: 'issue.updated' }); f.fire();
  assert.equal(f.requests[2].signal.aborted, true);
  f.requests[3].resolve(page(['fresh'])); await flush();
  f.requests[2].resolve(page(['stale-refresh'])); await flush();
  assert.deepEqual(f.state.items.map(item => item.key), ['fresh']);
  assert.equal(f.state.loading, false);
});

test('partial sources never produce an empty state and warnings survive later pages until a complete first page', async () => {
  const f = fixture();
  const first = f.controller.refresh(); f.requests[0].resolve(page([], { complete: false, failed_sources: ['attention'], next_cursor: 'next' })); await first;
  assert.equal(inboxIsEmpty(f.state), false);
  const more = f.controller.loadMore(); f.requests[1].resolve(page(['a'])); await more;
  assert.equal(f.state.complete, false); assert.deepEqual(f.state.failedSources, ['attention']);
  const retry = f.controller.refresh(); f.requests[2].resolve(page([])); await retry;
  assert.equal(inboxIsEmpty(f.state), true); assert.deepEqual(f.state.failedSources, []);
});

test('HTTP and malformed-response failures retain visible cards without claiming an empty queue', async () => {
  const f = fixture();
  assert.equal(inboxIsEmpty(f.state), false);
  const first = f.controller.refresh(); f.requests[0].resolve(page(['a'], { next_cursor: 'next' })); await first;
  const more = f.controller.loadMore(); f.requests[1].reject(new Error('offline')); await more;
  assert.deepEqual(f.state.items.map(item => item.key), ['a']); assert.equal(f.state.cursor, 'next');
  assert.equal(inboxIsEmpty(f.state), false);
  const refresh = f.controller.refresh(); f.requests[2].resolve({ items: [], total: 0 }); await refresh;
  assert.ok(f.state.error); assert.equal(inboxIsEmpty(f.state), false);
  assert.deepEqual(f.state.items.map(item => item.key), ['a']);
});

test('manual refresh aborts its predecessor and dispose cancels requests and scheduled refreshes', async () => {
  const f = fixture();
  const first = f.controller.refresh(); const second = f.controller.refresh();
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].reject(new Error('late failure')); await first;
  assert.equal(f.state.loading, true); assert.equal(f.state.error, null);
  f.controller.event({ type: 'issue.updated' }); const changes = f.states.length;
  f.controller.dispose(); assert.equal(f.timers, 0);
  f.requests[1].resolve(page(['late'])); await second;
  await f.controller.refresh(); f.controller.event({ type: 'issue.updated' }); f.fire();
  assert.equal(f.requests.length, 2); assert.equal(f.states.length, changes);
});
