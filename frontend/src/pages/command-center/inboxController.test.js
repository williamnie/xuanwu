import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxController, inboxInitialState, isInboxRefreshEvent } from './inboxController.js';
import { inboxIsEmpty } from './taskRequestsModel.js';

const item = key => ({ key, source: 'attention' });
const page = (keys, extra = {}) => ({ contract: 'xw.command-center.inbox.v1', items: keys.map(item), total: keys.length, counts: { attention: keys.length }, complete: true, failed_sources: [], next_cursor: null, ...extra });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const requests = [], timers = new Map(), states = [];
  let state = inboxInitialState(), timerID = 0, now = 0;
  const controller = createInboxController({
    fetchPage: (params, options) => new Promise((resolve, reject) => {
      assert.equal(requests.filter(request => !request.done && !request.signal.aborted).length, 0, 'only one live inbox request');
      const request = { at: now, params, signal: options.signal, done: false, resolve: value => { request.done = true; resolve(value); }, reject: error => { request.done = true; reject(error); } };
      requests.push(request);
    }),
    onChange: next => { state = next; states.push(next); },
    setTimer: (fn, delay) => { assert.equal(delay, 500); timers.set(++timerID, { fn, due: now + delay }); return timerID; },
    clearTimer: id => timers.delete(id),
  });
  const advance = async ms => {
    const until = now + ms;
    while ([...timers.values()].some(job => job.due <= until)) {
      const [id, job] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      now = job.due; timers.delete(id); job.fn(); await flush();
    }
    now = until; await flush();
  };
  return { controller, requests, states, advance, get state() { return state; }, get timers() { return timers.size; }, fire: () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(job => job.fn()); } };
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

test('events invalidate a pending cursor page, keep a fixed window and discard stale results', async () => {
  const f = fixture();
  const first = f.controller.refresh(); f.requests[0].resolve(page(['a'], { next_cursor: 'next' })); await first;
  const more = f.controller.loadMore();
  f.controller.event({ type: 'issue.updated' });
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(page(['late'])); await more;
  assert.deepEqual(f.state.items.map(item => item.key), ['a']);
  assert.equal(f.state.loading, false); assert.equal(f.state.loadingMore, false);
  await f.advance(200);
  for (const type of ['approval.resolved', 'pi.action_completed', 'attention.changed']) f.controller.event({ type });
  f.controller.event({ type: 'usage.updated' });
  assert.equal(f.timers, 1); assert.equal(f.requests.length, 2);
  await f.advance(300); assert.deepEqual(f.requests[2].params, { limit: 20 });
  assert.equal(f.requests[2].at, 500);
  // Further events do not abort an active refresh; a trailing read is coalesced.
  f.controller.event({ type: 'issue.updated' }); await f.advance(500);
  assert.equal(f.requests[2].signal.aborted, false); assert.equal(f.requests.length, 3);
  f.requests[2].resolve(page(['fresh'])); await flush();
  assert.equal(f.requests.length, 4);
  // A manual refresh still invalidates any old success/error/finally.
  const manual = f.controller.refresh();
  assert.equal(f.requests[3].signal.aborted, true);
  f.requests[4].resolve(page(['manual'])); await manual;
  f.requests[3].resolve(page(['stale-refresh'])); await flush();
  assert.deepEqual(f.state.items.map(item => item.key), ['manual']);
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

test('only inbox-changing EventBus types pass; streaming conversation and maintenance noise are ignored', async () => {
  for (const type of ['issue.created', 'issue.deleted', 'issue.status_changed', 'issue.updated', 'approval.resolved', 'attention.changed', 'pi.action_pending', 'pi.action_approved', 'pi.action_executing', 'pi.action_completed', 'pi.action_failed', 'pi.action_rejected', 'pi.action_changes_requested', 'pi.action_denied', 'pi.action_snoozed', 'pi.needs_user', 'pi.issue_ready_for_acceptance', 'pi.project_blocked']) assert.equal(isInboxRefreshEvent({ type }), true, type);
  for (const type of ['pi.conversation.event', 'pi.conversation.created', 'pi.memory_updated', 'pi.manager_cycle', 'pi.action.updated', 'issue.log', 'issue.progress', 'usage.updated', '']) assert.equal(isInboxRefreshEvent({ type }), false, type);
  for (const method of ['approval/requested', 'approval/resolved']) assert.equal(isInboxRefreshEvent({ type: 'codex.event', method }), true);
  for (const method of ['thread/name/updated', 'item/agentMessage/delta']) assert.equal(isInboxRefreshEvent({ type: 'codex.event', method }), false);
  const f = fixture(); const first = f.controller.refresh(); f.requests[0].resolve(page(['a'])); await first;
  for (let i = 0; i < 10; i++) { f.controller.event({ type: 'pi.conversation.event' }); await f.advance(200); }
  assert.equal(f.requests.length, 1); assert.equal(f.timers, 0); assert.equal(f.state.loading, false);
});

test('continuous 200ms relevant events start a read within each fixed 500ms window without a persistent spinner', async () => {
  const f = fixture(); const first = f.controller.refresh(); f.requests[0].resolve(page(['a'])); await first;
  const since = f.states.length;
  for (let i = 0; i < 10; i++) {
    f.controller.event({ type: 'pi.action_completed' }); await f.advance(200);
    for (const request of f.requests.filter(request => !request.done)) request.resolve(page(['a']));
    await flush();
  }
  await f.advance(500);
  for (const request of f.requests.filter(request => !request.done)) request.resolve(page(['a']));
  await flush();
  assert.deepEqual(f.requests.slice(1).map(request => request.at), [500, 1000, 1500, 2000, 2500]);
  assert.ok(f.states.slice(since).every(state => !state.loading && !state.loadingMore));
});

async function threePages(f) {
  const keys = Array.from({ length: 60 }, (_, i) => `old-${i}`);
  for (let offset = 0; offset < 60; offset += 20) {
    const pending = offset === 0 ? f.controller.refresh() : f.controller.loadMore();
    f.requests.at(-1).resolve(page(keys.slice(offset, offset + 20), { total: 100, next_cursor: `cursor-${offset + 20}` })); await pending;
  }
  return keys;
}

test('automatic and post-submit refresh preserve the loaded range atomically using limits of at most 50', async () => {
  const f = fixture(); const keys = await threePages(f); const since = f.states.length;
  f.controller.refreshAutomatically();
  assert.deepEqual(f.requests[3].params, { limit: 50 });
  f.requests[3].resolve(page(keys.slice(0, 50), { total: 100, next_cursor: 'new-50' })); await flush();
  assert.deepEqual(f.requests[4].params, { limit: 10, cursor: 'new-50' });
  assert.equal(f.state.items.length, 60, 'no intermediate 50-item collapse');
  f.requests[4].resolve(page(keys.slice(50), { total: 100, next_cursor: 'new-60' })); await flush();
  assert.deepEqual(f.state.items.map(item => item.key), keys); assert.equal(f.state.cursor, 'new-60');
  assert.ok(f.states.slice(since).every(state => !state.loading && state.items.length === 60));
  f.controller.refreshAutomatically(); f.requests[5].resolve(page(keys.slice(0, 22))); await flush();
  assert.equal(f.state.items.length, 22, 'stop when the source has no further page');
  const manual = f.controller.refresh(); assert.equal(f.state.loading, true);
  assert.deepEqual(f.requests[6].params, { limit: 20 }); f.requests[6].resolve(page(keys.slice(0, 20))); await manual;
  assert.equal(f.state.items.length, 20, 'only explicit manual refresh resets the range');
});

test('a failed automatic later page retains the entire old range, and partial warnings combine across refreshed pages', async () => {
  const f = fixture(); const keys = await threePages(f);
  f.controller.refreshAutomatically(); f.requests[3].resolve(page(keys.slice(0, 50), { total: 100, next_cursor: 'next' })); await flush();
  f.requests[4].reject(new Error('offline')); await flush();
  assert.deepEqual(f.state.items.map(item => item.key), keys); assert.equal(f.state.cursor, 'cursor-60'); assert.ok(f.state.error);
  f.controller.refreshAutomatically(); f.requests[5].resolve(page(keys.slice(0, 50), { total: 100, complete: false, failed_sources: ['human_review'], next_cursor: 'next' })); await flush();
  f.requests[6].resolve(page(keys.slice(50), { total: 100 })); await flush();
  assert.equal(f.state.complete, false); assert.deepEqual(f.state.failedSources, ['human_review']); assert.equal(f.state.items.length, 60);
});

test('load more remains usable during a silent refresh and waits for its fresh cursor without parallel requests', async () => {
  const f = fixture(); const keys = Array.from({ length: 20 }, (_, i) => `item-${i}`);
  const first = f.controller.refresh(); f.requests[0].resolve(page(keys, { next_cursor: 'old' })); await first;
  f.controller.refreshAutomatically();
  assert.equal(f.state.loading, false); assert.equal(f.state.loadingMore, false);
  f.controller.loadMore(); assert.equal(f.state.loadingMore, true); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(page(keys, { next_cursor: 'fresh' })); await flush();
  assert.deepEqual(f.requests[2].params, { limit: 20, cursor: 'fresh' });
  f.requests[2].resolve(page(['b'])); await flush();
  assert.deepEqual(f.state.items.map(item => item.key), [...keys, 'b']); assert.equal(f.state.loadingMore, false);
});
