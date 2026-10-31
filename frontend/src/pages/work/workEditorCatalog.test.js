import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { loadWorkCatalog, workCatalogKey, workCatalogSelection } from './workEditorCatalog.js';

const profiles = [{ id: 'remote-preset', provider: 'remote-only' }];
const catalog = [{ id: 'remote-only', submittable: true, capabilities: { issueExecution: true }, node_id: 'node', node_online: false }];
const key = workCatalogKey('remote', 'node');
const ready = { key, profiles, catalog, loading: false, error: '' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('project switch invalidates the previous catalog before the effect runs, retaining unavailable selection', () => {
  const selected = workCatalogSelection(ready, key, 'remote-preset', {});
  assert.equal(selected.selectedAvailable, true);
  const switched = workCatalogSelection(ready, workCatalogKey('local'), 'remote-preset', {});
  assert.equal(switched.loading, true);
  assert.equal(switched.selectedAvailable, false);
  assert.deepEqual(switched.catalog, []);
  assert.equal(workCatalogSelection({ ...ready, catalog: [] }, key, 'remote-preset', {}).selectedAvailable, false);
});

test('offline node catalog allows explicit and inherited presets without central tools', () => {
  assert.equal(workCatalogSelection(ready, key, '', { default_agent_profile_id: 'remote-preset' }).selectedAvailable, true);
  assert.equal(workCatalogSelection(ready, key, '', { provider: 'remote-only' }).inheritedAvailable, true);
  assert.equal(workCatalogSelection(ready, key, '', { provider: 'central-only' }).selectedAvailable, false);
  assert.equal(workCatalogSelection({ ...ready, error: 'failed' }, key, 'remote-preset', {}).selectedAvailable, false);
});

test('loads project-scoped providers and ignores late results after switching or unmounting', async () => {
  let resolveOld;
  const published = [];
  const cancel = loadWorkCatalog({ key: 'old', projectId: 'old', getProfiles: async () => profiles,
    getProviders: () => new Promise(resolve => { resolveOld = resolve; }), publish: state => published.push(state) });
  cancel();
  loadWorkCatalog({ key, projectId: 'remote', getProfiles: async () => ({ items: profiles }),
    getProviders: async options => { assert.deepEqual(options, { projectId: 'remote' }); return catalog; },
    publish: state => published.push(state) });
  await flush();
  resolveOld([]);
  await flush();
  assert.equal(published.length, 3);
  assert.deepEqual(published.at(-1), ready);
});

test('failed loading clears options, permits retry, and ignores obsolete failures', async () => {
  let rejectOld;
  const published = [];
  const publish = state => published.push(state);
  const stop = loadWorkCatalog({ key: 'old', getProfiles: async () => profiles,
    getProviders: () => new Promise((_, reject) => { rejectOld = reject; }), publish });
  stop();
  const args = { key, projectId: 'remote', getProfiles: async () => profiles, publish };
  loadWorkCatalog({ ...args, getProviders: async () => { throw new Error('offline API'); } });
  await flush();
  assert.equal(published.at(-1).error, 'offline API');
  assert.deepEqual(published.at(-1).catalog, []);
  loadWorkCatalog({ ...args, getProviders: async () => catalog });
  await flush();
  rejectOld(new Error('old failure'));
  await flush();
  assert.deepEqual(published.at(-1), ready);
});

test('editing keeps the unchanged original preset saveable even when the catalog no longer offers it', () => {
  const empty = { ...ready, catalog: [] };
  assert.equal(workCatalogSelection(empty, key, 'remote-preset', {}, 'remote-preset').selectedAvailable, true);
  assert.equal(workCatalogSelection(empty, key, '', { provider: 'gone' }, '').selectedAvailable, true);
  assert.equal(workCatalogSelection(empty, key, 'other', {}, 'remote-preset').selectedAvailable, false);
  assert.equal(workCatalogSelection({ ...empty, loading: true }, key, 'remote-preset', {}, 'remote-preset').selectedAvailable, false);
});
