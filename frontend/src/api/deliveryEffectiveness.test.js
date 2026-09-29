import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeliveryEffectiveness } from './deliveryEffectiveness.js';

async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
const busy = () => Response.json({ message: 'delivery statistics busy; retry later' }, { status: 429 });

test('delivery filters recover from a prior request still holding the read budget', async () => {
  let calls = 0;
  await withFetch(async url => {
    assert.equal(new URL(url, 'http://localhost').searchParams.get('project_id'), 'latest');
    return ++calls === 1 ? busy() : Response.json({ sampled_works: 3 });
  }, async () => {
    assert.deepEqual(await getDeliveryEffectiveness({ project_id: 'latest' }), { sampled_works: 3 });
    assert.equal(calls, 2);
  });
});

test('delivery retries remain bounded and other API failures are not retried', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return busy(); }, async () => {
    await assert.rejects(getDeliveryEffectiveness({}), error => error.status === 429 && /稍后重试/.test(error.message));
    assert.equal(calls, 3);
  });
  calls = 0;
  await withFetch(async () => { calls++; return Response.json({ message: 'invalid range' }, { status: 400 }); }, async () => {
    await assert.rejects(getDeliveryEffectiveness({}), error => error.status === 400);
    assert.equal(calls, 1);
  });
});

test('changing filters aborts a pending retry without dispatching stale reads', async () => {
  const controller = new AbortController();
  let calls = 0;
  await withFetch(async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return busy();
  }, async () => {
    await assert.rejects(getDeliveryEffectiveness({}, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls, 1);
  });
});
