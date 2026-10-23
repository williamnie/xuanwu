import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionRuntimeSettings } from './sessionRuntimeSettings.js';

test('session runtime settings parse persisted raw_ref when direct fields are absent', () => {
  assert.deepEqual(sessionRuntimeSettings({
    raw_ref: JSON.stringify({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
      service_tier: 'priority',
      approval_policy: 'danger-only',
      sandbox: 'read-only',
    }),
  }), {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    approvalPolicy: 'danger-only',
    sandbox: 'read-only',
  });
});
