import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { availableAgentProfiles } from '../utils/codeAgents.js';
import { loadProjectPresetCatalog, projectPresetCatalogState } from './projectPresetCatalog.js';

const entry = id => ({ id, enabled: true, submittable: true, capabilities: { issueExecution: true } });
const local = [entry('codex')];
const profiles = [{ id: 'local', provider: 'codex' }, { id: 'remote', provider: 'claude' }];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('remote presets use only node catalog while local presets retain local filtering', async () => {
  let state;
  loadProjectPresetCatalog('node-a', async options => {
    assert.deepEqual(options, { nodeId: 'node-a' });
    return [entry('claude')];
  }, value => { state = value; });
  await tick();
  assert.deepEqual(availableAgentProfiles(profiles, projectPresetCatalogState(state, 'node-a', local).catalog), [profiles[1]]);
  assert.deepEqual(availableAgentProfiles(profiles, projectPresetCatalogState(state, '', local).catalog), [profiles[0]]);
  assert.deepEqual(projectPresetCatalogState(state, 'node-b', local), { catalog: [], loading: true, error: '' });
});

test('late node responses cannot overwrite a switched selection and failures never use local tools', async () => {
  let finish;
  const states = [];
  const cancel = loadProjectPresetCatalog('a', () => new Promise(resolve => { finish = resolve; }), value => states.push(value));
  cancel();
  finish(local);
  await tick();
  assert.equal(states.length, 1);
  loadProjectPresetCatalog('b', async () => { throw new Error('node unavailable'); }, value => states.push(value));
  await tick();
  assert.deepEqual(projectPresetCatalogState(states.at(-1), 'b', local), {
    nodeId: 'b', catalog: [], loading: false, error: 'node unavailable',
  });
});
