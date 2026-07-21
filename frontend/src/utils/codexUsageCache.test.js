import assert from 'node:assert/strict';
import test from 'node:test';

import { readCodexUsageCache, writeCodexUsageCache } from './codexUsageCache.js';

test('Codex usage cache persists the last successful dashboard value', () => {
  const storage = new MemoryStorage();
  const usage = { generated_at: '2026-07-21T00:00:00.000Z', events_scanned: 12 };

  writeCodexUsageCache(usage, storage);

  assert.deepEqual(readCodexUsageCache(storage), usage);
});

test('Codex usage cache ignores malformed or unavailable storage', () => {
  assert.equal(readCodexUsageCache(new MemoryStorage('{broken')), null);
  assert.doesNotThrow(() => writeCodexUsageCache({ events_scanned: 1 }, {
    setItem() { throw new Error('quota exceeded'); },
  }));
});

class MemoryStorage {
  constructor(value = null) {
    this.value = value;
  }

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}
