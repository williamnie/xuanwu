import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_REQUIRED_MESSAGE,
  SESSIONS_UNSUPPORTED_MESSAGE,
  canCreateSession,
  readySessionProviders,
  resolveLastSessionProject,
} from './newSessionGuards.js';

test('blocks new session when project is not selected', () => {
  const result = canCreateSession({ projectId: '', cwd: '', prompt: 'hello' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_project');
  assert.equal(result.message, PROJECT_REQUIRED_MESSAGE);
});

test('allows new session when prompt and project cwd are present', () => {
  const result = canCreateSession({
    projectId: 'demo',
    cwd: '/tmp/demo',
    prompt: 'hello',
    selectedProject: { provider_capabilities: ['sessions'] },
  });

  assert.equal(result.ok, true);
});

test('blocks new session when selected project is unavailable in Sessions UI', () => {
  const result = canCreateSession({ projectId: 'demo', cwd: '/tmp/demo', prompt: 'hello' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_project');
});

test('blocks new session for execution-only provider project', () => {
  const result = canCreateSession({
    projectId: 'demo',
    cwd: '/tmp/demo',
    prompt: 'hello',
    selectedProject: { provider_capabilities: ['issue_execution'] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_provider');
  assert.equal(result.message, SESSIONS_UNSUPPORTED_MESSAGE);
});

test('resolves last session project from project list', () => {
  const project = { id: 'demo', cwd: '/tmp/demo', provider_capabilities: ['sessions'] };

  assert.equal(resolveLastSessionProject([project], 'demo'), project);
  assert.equal(resolveLastSessionProject([project], 'missing'), null);
});

test('does not restore execution-only provider as last session project', () => {
  const project = { id: 'demo', cwd: '/tmp/demo', provider_capabilities: ['issue_execution'] };

  assert.equal(resolveLastSessionProject([project], 'demo'), null);
});

test('allows only ready session-capable runtime providers and blocks unready Claude SDK', () => {
  const status = {
    providers: [
      { id: 'codex', label: 'Codex', available: true, ready: true, capabilities: ['sessions'] },
      { id: 'claude', label: 'Claude Agent SDK', available: false, ready: false, capabilities: ['sessions'], readiness_reason: 'API key missing' },
      { id: 'fake-execution-only', available: true, ready: true, capabilities: ['issue_execution'] },
    ],
  };
  assert.deepEqual(readySessionProviders(status), [{ id: 'codex', label: 'Codex', capabilities: ['sessions'] }]);
  const result = canCreateSession({
    projectId: 'demo', cwd: '/tmp/demo', prompt: 'hello', selectedProject: { provider_capabilities: ['sessions'] },
    providerId: 'claude', providerStatus: status.providers[1],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider_not_ready');
  assert.equal(result.message, 'API key missing');
});
