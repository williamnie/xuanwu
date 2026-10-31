import { readSessionPageSource } from './sessionTestSources.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteSessionProviders } from './remoteSessionProviders.js';
import { readySessionProviders, canCreateSession } from './newSessionGuards.js';

test('node catalog exposes only enabled, submittable session creators with node labels', () => {
  const entry = { id: 'remote-tool', label: '节点工具', enabled: true, submittable: true, capabilities: { sessions: { create: true } } };
  const status = remoteSessionProviders([
    entry,
    { ...entry, id: 'disabled', enabled: false },
    { ...entry, id: 'unready', submittable: false },
    { ...entry, id: 'read-only', capabilities: { sessions: { read: true } } },
  ]);
  assert.deepEqual(readySessionProviders(status).map(item => [item.id, item.label]), [['remote-tool', '节点工具']]);
  assert.equal(canCreateSession({ projectId: 'remote', cwd: '/repo', prompt: 'hello', selectedProject: {}, providerStatus: status.providers[0] }).ok, true);
  assert.equal(canCreateSession({ projectId: 'remote', cwd: '/repo', prompt: 'hello', selectedProject: {}, providerStatus: status.providers[3] }).ok, false);
});

test('empty or failed node catalog never falls back to local tools', () => {
  assert.deepEqual(readySessionProviders(remoteSessionProviders(null)), []);
  assert.deepEqual(readySessionProviders(remoteSessionProviders([])), []);
});

test('project-scoped requests discard stale responses and both submit paths honor node availability', async () => {
  const { readFile } = await import('node:fs/promises');
  const hook = await readFile(new URL('./useNewSessionProviders.js', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('./NewSessionWorkspace.jsx', import.meta.url), 'utf8');
  const page = readSessionPageSource();
  assert.match(hook, /getProviders\(\{ projectId, signal: controller.signal \}\)/);
  assert.match(hook, /remoteCatalog\?\.projectId === projectId/);
  assert.match(hook, /alive = false; controller.abort\(\)/);
  assert.match(hook, /nodeOnline === false/);
  assert.match(hook, /'节点离线'/);
  assert.match(workspace, /onSubmitKey=\{!blockedReason && selectedProviderAvailable/);
  assert.match(workspace, /canSubmit=\{!blockedReason && selectedProviderAvailable/);
  assert.match(page, /if \(newSessionBlockedReason\).*return;/);
  assert.match(page, /providerCatalog: newProviderCatalog/);
});
