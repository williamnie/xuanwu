import assert from 'node:assert/strict';
import test from 'node:test';
import { commandCenterApi } from './commandCenter.js';

test('Inbox and approval reads preserve opaque identifiers and forward cancellation to fetch', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, signal: options.signal });
    return new Response('{}', { status: 200 });
  };
  try {
    const controller = new AbortController();
    const cursor = 'opaque+/=&next';
    const id = 'xw:attention:pi_actions:approval/1';
    await commandCenterApi.getInbox();
    await commandCenterApi.getInbox({ limit: 20, cursor }, { signal: controller.signal });
    await commandCenterApi.getAttention(id, { signal: controller.signal });
    assert.equal(requests[0].url, '/api/command-center/inbox?limit=20');
    assert.equal(new URL(requests[1].url, 'http://localhost').searchParams.get('cursor'), cursor);
    assert.equal(requests[2].url, `/api/command-center/attention/${encodeURIComponent(id)}`);
    assert.equal(requests[1].signal, controller.signal);
    assert.equal(requests[2].signal, controller.signal);
    controller.abort();
    assert.ok(requests.slice(1).every(request => request.signal.aborted));
  } finally { globalThis.fetch = previousFetch; }
});
