import assert from 'node:assert/strict';
import test from 'node:test';
import { nodesApi } from '../api/nodes.js';
import { useDataStore } from './dataStore.js';

test('node refresh deduplicates requests and forced polling bypasses stale cache', async () => {
  const original = nodesApi.listNodes;
  const refresh = useDataStore.getState().refreshNodes;
  let resolve;
  let calls = 0;
  nodesApi.listNodes = () => { calls++; return new Promise(done => { resolve = done; }); };
  try {
    const first = refresh({ force: true });
    const second = refresh({ force: true });
    assert.equal(first, second);
    assert.equal(calls, 1);
    resolve({ nodes: [{ id: 'remote', online: false }] });
    await first;
    assert.equal(useDataStore.getState().nodesById.get('remote').online, false);
    await refresh();
    assert.equal(calls, 1);
    const reconnect = refresh({ force: true });
    assert.equal(calls, 2);
    resolve({ nodes: [{ id: 'remote', name: 'hermes', online: true }] });
    await reconnect;
    assert.equal(useDataStore.getState().nodesById.get('remote').online, true);
    nodesApi.listNodes = async () => { throw new Error('unavailable'); };
    await refresh({ force: true });
    assert.deepEqual(useDataStore.getState().nodesById.get('remote'), { id: 'remote', name: 'hermes', online: undefined });
  } finally {
    nodesApi.listNodes = original;
  }
});
