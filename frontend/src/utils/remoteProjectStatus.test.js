import test from 'node:test';
import assert from 'node:assert/strict';
import { isWaitingForProjectNode } from './remoteProjectStatus.js';

test('only pending remote work with confirmed offline node waits; reconnect clears it', () => {
  const project = { node_id: 'remote' };
  const nodes = new Map([['remote', { online: false }]]);
  assert.equal(isWaitingForProjectNode({ status: 'todo' }, project, nodes), true);
  for (const status of ['in_progress', 'done', 'failed', 'triage', 'needs_user', 'cancelled']) {
    assert.equal(isWaitingForProjectNode({ status }, project, nodes), false);
  }
  assert.equal(isWaitingForProjectNode({ status: 'todo' }, {}, nodes), false);
  assert.equal(isWaitingForProjectNode({ status: 'todo' }, project, new Map()), false);
  nodes.set('remote', { online: true });
  assert.equal(isWaitingForProjectNode({ status: 'todo' }, project, nodes), false);
});
