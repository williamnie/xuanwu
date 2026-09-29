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

test('healthy Core probes continue until SSE reopens and can detect a later outage', async () => {
  const scheduler = fakeScheduler();
  const states = [];
  let healthy = true;
  const monitor = createBackendConnectionMonitor({
    onStateChange: state => states.push(state),
    probe: async () => {
      if (!healthy) throw new Error('core unavailable');
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  monitor.onError();
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting']);
  healthy = false;
  await scheduler.runNext();
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting', 'offline']);
  healthy = true;
  await scheduler.runNext();
  assert.deepEqual(states, ['reconnecting', 'offline', 'reconnecting']);
  assert.equal(scheduler.pendingCount(), 1);
  monitor.onOpen();
  assert.deepEqual(states, ['reconnecting', 'offline', 'reconnecting', 'online']);
  assert.equal(scheduler.pendingCount(), 0);
});

test('stopping a connection monitor cancels a successful probe retry', async () => {
  const scheduler = fakeScheduler();
  const monitor = createBackendConnectionMonitor({
    onStateChange: () => {},
    probe: async () => {},
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  monitor.onError();
  await scheduler.runNext();
  assert.equal(scheduler.pendingCount(), 1);
  monitor.stop();
  assert.equal(scheduler.pendingCount(), 0);
});

test('a stale probe completion cannot change the state after SSE opens', async () => {
  const scheduler = fakeScheduler();
  const states = [];
  let resolveProbe;
  const monitor = createBackendConnectionMonitor({
    onStateChange: state => states.push(state),
    probe: () => new Promise(resolve => { resolveProbe = resolve; }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  monitor.onError();
  await scheduler.runNext();
  monitor.onOpen();
  resolveProbe();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(states, ['reconnecting', 'online']);
  assert.equal(scheduler.pendingCount(), 0);
  monitor.stop();
});

test('an old probe timeout cannot abort a newer health probe', async t => {
  const scheduler = fakeScheduler();
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timeouts = [];
  const pending = new Set();
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 1_500);
    timeouts.push(callback);
    pending.add(callback);
    return callback;
  };
  globalThis.clearTimeout = callback => pending.delete(callback);
  t.after(() => {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  });
  const probes = [];
  const monitor = createBackendConnectionMonitor({
    onStateChange: () => {},
    probe: signal => new Promise(resolve => { probes.push({ signal, resolve }); }),
    probeDelayMs: 0,
    probeTimeoutMs: 1_500,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  t.after(() => monitor.stop());
  monitor.onError();
  await scheduler.runNext();
  monitor.onOpen();
  assert.equal(probes[0].signal.aborted, true);
  monitor.onError();
  await scheduler.runNext();
  assert.equal(pending.size, 2);
  timeouts[0]();
  assert.equal(probes[1].signal.aborted, false);
  timeouts[1]();
  assert.equal(probes[1].signal.aborted, true);
  for (const probe of probes) probe.resolve();
  await Promise.resolve();
  assert.equal(pending.size, 0);
});

function fakeScheduler() {
  let nextID = 1;
  const tasks = new Map();
  return {
    pendingCount() {
      return tasks.size;
    },
    cancel(id) {
      tasks.delete(id);
    },
    async runNext() {
      const entry = tasks.entries().next().value;
      assert.ok(entry, 'expected a scheduled probe');
      const [id, callback] = entry;
      tasks.delete(id);
      callback();
      await Promise.resolve();
    },
    schedule(callback) {
      const id = nextID;
      nextID += 1;
      tasks.set(id, callback);
      return id;
    },
  };
}
