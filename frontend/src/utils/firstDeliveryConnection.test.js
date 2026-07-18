import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearFirstDeliveryConnectionTest,
  readFirstDeliveryConnectionTest,
  recordFirstDeliveryConnectionTest,
} from './firstDeliveryConnection.js';

test('keeps only a recent successful audited connection result in session state', () => {
  const storage = memoryStorage();
  recordFirstDeliveryConnectionTest({ ok: true, provider_id: 'openai', status: 'connected' }, storage, 1_000);
  assert.deepEqual(readFirstDeliveryConnectionTest(storage, 2_000), {
    ok: true,
    provider_id: 'openai',
    status: 'connected',
    tested_at_ms: 1_000,
  });
  assert.equal(readFirstDeliveryConnectionTest(storage, 1_000 + 31 * 60 * 1000), null);
  clearFirstDeliveryConnectionTest(storage);
  assert.equal(readFirstDeliveryConnectionTest(storage, 2_000), null);
});

test('failed connection clears any prior success', () => {
  const storage = memoryStorage();
  recordFirstDeliveryConnectionTest({ ok: true, provider_id: 'openai' }, storage, 1_000);
  recordFirstDeliveryConnectionTest({ ok: false, provider_id: 'openai' }, storage, 2_000);
  assert.equal(readFirstDeliveryConnectionTest(storage, 2_000), null);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
