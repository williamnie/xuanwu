import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeHealth } from './runtimeHealth.js';

const healthyStatus = {
  service: { alive: true },
  db: { ok: true },
  codex: { command_ok: true, command: 'codex' },
  config: { auth_enabled: true },
  runner: { running_loops: 2, running_issues: 1, in_progress_issues: 3, running_sessions: 4 },
};

test('summarizes healthy runtime status', () => {
  const health = buildRuntimeHealth({ status: healthyStatus, backendOnline: false });

  assert.equal(health.ok, true);
  assert.equal(health.title, 'Runtime healthy');
  assert.deepEqual(health.items.map(item => item.label), ['API', 'Codex command', 'DB', 'Running', 'Auth']);
  assert.equal(health.items.find(item => item.label === 'Running').value, 'loops 2 · issues 1/3 · sessions 4');
});

test('surfaces codex command failures first among runtime checks', () => {
  const health = buildRuntimeHealth({
    status: {
      ...healthyStatus,
      codex: { command_ok: false, command_error: 'codex not found' },
    },
    backendOnline: true,
  });

  assert.equal(health.ok, false);
  assert.equal(health.title, 'Runtime 需要关注');
  assert.equal(health.reason, 'Codex codex not found');
});

test('surfaces API read errors without requiring deep probes', () => {
  const health = buildRuntimeHealth({ status: null, error: 'unauthorized', backendOnline: false });

  assert.equal(health.ok, false);
  assert.equal(health.reason, 'API unauthorized');
  assert.equal(health.items.find(item => item.label === 'API').value, 'down');
});
