import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eventsApi } from './events.js';
import { createBackendConnectionMonitor } from './backendConnectionMonitor.js';

const assistantSource = readFileSync(new URL('./assistant.js', import.meta.url), 'utf8');
const eventsSource = readFileSync(new URL('./events.js', import.meta.url), 'utf8');
const workSource = readFileSync(new URL('./work.js', import.meta.url), 'utf8');

test('api events client shares one EventSource across subscribers', () => {
  assert.match(eventsSource, /let sharedEventSource = null/);
  assert.match(eventsSource, /const eventSubscribers = new Set\(\)/);
  assert.match(eventsSource, /function ensureSharedEventSource\(\)/);
  assert.match(eventsSource, /eventSubscribers\.size === 0[\s\S]*sharedEventSource\?\.close\(\)/);
});

test('api client exposes PI conversation interrupt endpoint', () => {
  assert.match(assistantSource, /interruptPiConversation:\s*\(id\) => request/);
  assert.ok(assistantSource.includes('`/api/pi/conversations/${encodeURIComponent(id)}/interrupt`'));
});

test('api client sends PI messages through the dedicated POST SSE consumer', () => {
  assert.match(
    assistantSource,
    /sendPiConversationMessage:\s*\(id, message, options\) => streamPiConversationMessage\(id, message, options\)/,
  );
});

test('api client exposes global and issue-scoped event summary queries', () => {
  assert.match(eventsSource, /getEventSummaries:/);
  assert.match(eventsSource, /`\/api\/event-summaries\$\{query\}`/);
  assert.match(workSource, /getIssueEventSummaries:/);
  assert.match(workSource, /`\/api\/issues\/\$\{id\}\/event-summaries\$\{query\}`/);
});

test('closed SSE reconnects once and resumes delivery to existing subscribers', t => {
  const harness = eventSourceHarness(t);
  const states = [];
  const messages = [];
  harness.subscribe(data => messages.push(data), () => states.push('error'), () => states.push('open'));
  harness.sources[0].open();
  harness.sources[0].fail(2);
  harness.sources[0].fail(2);
  harness.subscribe(data => messages.push(data));
  assert.equal(harness.sources.length, 1, 'new subscribers must share the pending retry');

  harness.tick(1_000);
  assert.equal(harness.sources.length, 2, 'CLOSED requires a new EventSource');
  harness.sources[1].open();
  harness.sources[1].onmessage({ data: '{"type":"issue_updated"}' });
  assert.deepEqual(states, ['open', 'error', 'error', 'open']);
  assert.deepEqual(messages, [{ type: 'issue_updated' }, { type: 'issue_updated' }]);
});

test('native SSE reconnection is preserved while readyState is CONNECTING', t => {
  const harness = eventSourceHarness(t);
  harness.subscribe(() => {});
  harness.sources[0].fail(0);
  harness.tick(60_000);
  assert.equal(harness.sources.length, 1);
  assert.equal(harness.sources[0].closeCalls, 0);
});

test('closed SSE retries use capped backoff and reset after the stream opens', t => {
  const harness = eventSourceHarness(t);
  harness.subscribe(() => {});
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const count = harness.sources.length;
    harness.sources.at(-1).fail(2);
    harness.tick(delay - 1);
    assert.equal(harness.sources.length, count);
    harness.tick(1);
    assert.equal(harness.sources.length, count + 1);
  }
  harness.sources.at(-1).open();
  harness.sources.at(-1).fail(2);
  harness.tick(1_000);
  assert.equal(harness.sources.length, 9);
});

test('last unsubscribe cancels SSE retries and discards old callbacks', t => {
  const harness = eventSourceHarness(t);
  const unsubscribe = harness.subscribe(() => {});
  const oldSource = harness.sources[0];
  oldSource.fail(2);
  unsubscribe();
  harness.tick(60_000);
  assert.equal(harness.sources.length, 1);
  assert.equal(oldSource.closeCalls, 1);

  const states = [];
  const messages = [];
  harness.subscribe(data => messages.push(data), () => states.push('error'), () => states.push('open'));
  oldSource.onopen();
  oldSource.onmessage({ data: '{"stale":true}' });
  oldSource.onerror(new Event('error'));
  assert.deepEqual(states, []);
  assert.deepEqual(messages, []);
  harness.sources[1].open();
  assert.deepEqual(states, ['open']);
  harness.tick(60_000);
  assert.equal(harness.sources.length, 2);
});

test('late SSE subscribers receive the current open or reconnecting state', t => {
  const harness = eventSourceHarness(t);
  const states = [];
  harness.subscribe(() => {});
  harness.sources[0].open();
  harness.subscribe(() => {}, () => states.push('error'), () => states.push('open'));
  assert.deepEqual(states, ['open']);
  harness.sources[0].fail(0);
  harness.subscribe(() => {}, () => states.push('late-error'));
  assert.deepEqual(states, ['open', 'error', 'late-error']);
});

test('Core recovery and a rebuilt SSE return the connection monitor to online', async t => {
  const harness = eventSourceHarness(t);
  const states = [];
  let probes = 0;
  const monitor = createBackendConnectionMonitor({
    onStateChange: state => states.push(state),
    probe: async () => { probes += 1; },
  });
  t.after(() => monitor.stop());
  harness.subscribe(() => {}, () => monitor.onError(), () => monitor.onOpen());
  harness.sources[0].open();
  harness.sources[0].fail(2);
  harness.tick(750);
  await Promise.resolve();
  assert.deepEqual(states, ['online', 'reconnecting']);
  assert.equal(probes, 1);
  harness.tick(250);
  harness.sources[1].open();
  assert.deepEqual(states, ['online', 'reconnecting', 'online']);
  harness.tick(60_000);
  assert.equal(probes, 1, 'the recovered stream stops health polling');
});

function eventSourceHarness(t) {
  const previous = globalThis.EventSource;
  const sources = [];
  const subscriptions = new Set();
  const timers = installFakeTimers();
  globalThis.EventSource = class {
    readyState = 0;
    closeCalls = 0;

    constructor(url) {
      assert.equal(url, '/api/events');
      sources.push(this);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 2;
    }

    open() {
      this.readyState = 1;
      this.onopen();
    }

    fail(state) {
      this.readyState = state;
      this.onerror(new Event('error'));
    }
  };
  t.after(() => {
    for (const unsubscribe of subscriptions) unsubscribe();
    if (previous === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previous;
    timers.restore();
  });
  return {
    sources,
    tick: timers.tick,
    subscribe(...args) {
      const unsubscribe = eventsApi.subscribeToEvents(...args);
      subscriptions.add(unsubscribe);
      return () => {
        subscriptions.delete(unsubscribe);
        unsubscribe();
      };
    },
  };
}

function installFakeTimers() {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextID = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = ++nextID;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  return {
    tick(duration) {
      const end = now + duration;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
    restore() {
      timers.clear();
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}
