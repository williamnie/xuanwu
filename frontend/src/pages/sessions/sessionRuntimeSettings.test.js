import assert from 'node:assert/strict';
import test from 'node:test';

import { messageSettingsForSession, sessionRuntimeSettings } from './sessionRuntimeSettings.js';

test('message settings prefer selected session runtime values over project defaults', () => {
  const settings = messageSettingsForSession({
    model: 'gpt-5.5',
    reasoning_effort: 'xhigh',
    service_tier: 'priority',
    approval_policy: 'always',
    sandbox: 'danger-full-access',
  }, {
    provider: 'codex',
    model: 'codex-default',
    approval_policy: 'never',
    sandbox: 'workspace-write',
  });

  assert.deepEqual(settings, {
    provider: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    serviceTier: 'priority',
    approvalPolicy: 'always',
    sandbox: 'danger-full-access',
  });
});

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
