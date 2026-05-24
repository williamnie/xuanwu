import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_REQUIRED_MESSAGE,
  SESSIONS_UNSUPPORTED_MESSAGE,
  canCreateSession,
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
