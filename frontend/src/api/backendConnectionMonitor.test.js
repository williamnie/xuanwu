import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackendConnectionMonitor } from './backendConnectionMonitor.js';

test('a transient SSE error stays reconnecting until the stream opens again', async () => {
  const scheduler = fakeScheduler();
  const states = [];
  const monitor = createBackendConnectionMonitor({
    onStateChange: state => states.push(state),
    probe: async () => ({ status: 'ok' }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  monitor.onError();
  assert.deepEqual(states, ['reconnecting']);
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting']);

  monitor.onOpen();
  assert.deepEqual(states, ['reconnecting', 'online']);
});

test('only consecutive failed Core probes mark the backend offline', async () => {
  const scheduler = fakeScheduler();
  const states = [];
  const monitor = createBackendConnectionMonitor({
    failureThreshold: 2,
    onStateChange: state => states.push(state),
    probe: async () => { throw new Error('core unavailable'); },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  monitor.onError();
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting']);
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting', 'offline']);

  monitor.onOpen();
  assert.deepEqual(states, ['reconnecting', 'offline', 'online']);
});

function fakeScheduler() {
  let nextID = 1;
  const tasks = new Map();
  return {
    cancel(id) {
      tasks.delete(id);
    },
    async runNext() {
      const entry = tasks.entries().next().value;
      assert.ok(entry, 'expected a scheduled probe');
      const [id, callback] = entry;
      tasks.delete(id);
      callback();
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    schedule(callback) {
      const id = nextID;
      nextID += 1;
      tasks.set(id, callback);
      return id;
    },
  };
}
