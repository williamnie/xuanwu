import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_REQUIRED_MESSAGE,
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
  const result = canCreateSession({ projectId: 'demo', cwd: '/tmp/demo', prompt: 'hello' });

  assert.equal(result.ok, true);
});

test('resolves last session project from project list', () => {
  const project = { id: 'demo', cwd: '/tmp/demo' };

  assert.equal(resolveLastSessionProject([project], 'demo'), project);
  assert.equal(resolveLastSessionProject([project], 'missing'), null);
});
