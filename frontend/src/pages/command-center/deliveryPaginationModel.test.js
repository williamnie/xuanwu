import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryPageState, deliveryPageReducer } from './deliveryPaginationModel.js';

const filters = { project_id: '', task_type: '', from: '2026-09-01T00:00:00.000Z', to: '2026-09-29T23:59:59.999Z', limit: 25 };
const firstPage = { sampled_works: 25, has_more: true, next_before_issue_id: 50 };
function loaded() {
  const state = createDeliveryPageState(filters);
  return deliveryPageReducer(state, { type: 'success', id: state.request.id, snapshot: firstPage });
}
function finish(state, snapshot) {
  return deliveryPageReducer(state, { type: 'success', id: state.request.id, snapshot });
}

test('pending pagination keeps the visible snapshot and page number until success', () => {
  const state = loaded();
  const pending = deliveryPageReducer(state, { type: 'next' });
  assert.equal(pending.snapshot, firstPage);
  assert.deepEqual(pending.history, []);
  assert.equal(pending.filters.before_issue_id, undefined);
  assert.equal(pending.request.filters.before_issue_id, 50);
  assert.equal(pending.loading, true);
  assert.equal(deliveryPageReducer(pending, { type: 'next' }), pending);
  assert.equal(deliveryPageReducer(pending, { type: 'filters', patch: { project_id: 'other' } }), pending);
  const secondPage = { sampled_works: 2, has_more: false };
  const complete = finish(pending, secondPage);
  assert.equal(complete.snapshot, secondPage);
  assert.equal(complete.history.length, 1);
  assert.equal(complete.filters.before_issue_id, 50);
  assert.equal(complete.loading, false);
});

test('failed next-page reads keep the last successful page and retry the requested cursor', () => {
  const pending = deliveryPageReducer(loaded(), { type: 'next' });
  const failed = deliveryPageReducer(pending, { type: 'failure', id: pending.request.id, error: 'network unavailable' });
  assert.equal(failed.snapshot, firstPage);
  assert.equal(failed.history.length, 0);
  assert.equal(failed.filters.before_issue_id, undefined);
  assert.equal(failed.error, 'network unavailable');
  const retry = deliveryPageReducer(failed, { type: 'retry' });
  assert.equal(retry.request.filters.before_issue_id, 50);
  assert.equal(retry.request.history.length, 1);
  assert.ok(retry.request.id > pending.request.id);
});

test('filter success resets pagination; filter failure leaves data and labels paired', () => {
  const pageTwo = finish(deliveryPageReducer(loaded(), { type: 'next' }), { sampled_works: 2, has_more: false });
  const pending = deliveryPageReducer(pageTwo, { type: 'filters', patch: { project_id: 'new-project' } });
  assert.equal(pending.filters.project_id, '');
  assert.equal(pending.snapshot, pageTwo.snapshot);
  assert.equal(pending.history.length, 1);
  assert.equal(pending.request.filters.before_issue_id, undefined);
  const failed = deliveryPageReducer(pending, { type: 'failure', id: pending.request.id, error: 'query failed' });
  assert.equal(failed.filters, pageTwo.filters);
  assert.equal(failed.history, pageTwo.history);
  const complete = finish(deliveryPageReducer(failed, { type: 'retry' }), { sampled_works: 0, has_more: true, next_before_issue_id: 20 });
  assert.equal(complete.filters.project_id, 'new-project');
  assert.deepEqual(complete.history, []);
  assert.equal(deliveryPageReducer(complete, { type: 'next' }).request.filters.before_issue_id, 20);
});

test('old responses cannot overwrite a newer page or clear its pending state', () => {
  const pending = deliveryPageReducer(loaded(), { type: 'next' });
  assert.equal(deliveryPageReducer(pending, { type: 'success', id: pending.request.id - 1, snapshot: {} }), pending);
  assert.equal(deliveryPageReducer(pending, { type: 'failure', id: pending.request.id - 1, error: 'stale' }), pending);
});

test('previous-page cursor and history are committed together after successful reads', () => {
  const pageTwo = finish(deliveryPageReducer(loaded(), { type: 'next' }), { sampled_works: 2, has_more: false });
  assert.equal(deliveryPageReducer(pageTwo, { type: 'next' }), pageTwo);
  const pending = deliveryPageReducer(pageTwo, { type: 'previous' });
  assert.equal(pending.history.length, 1);
  assert.equal(pending.filters.before_issue_id, 50);
  assert.equal(pending.request.filters.before_issue_id, undefined);
  const complete = finish(pending, firstPage);
  assert.deepEqual(complete.history, []);
  assert.equal(complete.filters.before_issue_id, undefined);
  assert.equal(deliveryPageReducer(complete, { type: 'previous' }), complete);
});
