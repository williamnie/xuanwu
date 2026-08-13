import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EXECUTION_POLICY,
  applyExecutionPolicy,
  executionPolicyPresets,
  legacyExecutionPolicy,
  profileExecutionPolicy,
  projectExecutionPolicy,
} from './executionPolicy.js';

test('new project policy defaults to unattended host access', () => {
  assert.deepEqual(projectExecutionPolicy({}), DEFAULT_EXECUTION_POLICY);
});

test('legacy settings map in both directions during the compatibility window', () => {
  const policy = legacyExecutionPolicy('workspace-write', 'always');
  assert.deepEqual(policy, {
    contract: 'xw.execution-policy.v1',
    access: 'provider-native-development',
    approval: 'ask-every-side-effect',
  });
  assert.deepEqual(applyExecutionPolicy({}, policy), {
    executionPolicy: policy,
    sandbox: 'workspace-write',
    approvalPolicy: 'always',
  });
});

test('empty profile policy inherits from the project', () => {
  assert.equal(profileExecutionPolicy({ execution_policy: {} }), null);
});

test('catalog transport disables unsupported combinations without hiding lower-permission choices', () => {
  const catalog = [{
    id: 'claude',
    runtime: { mode: 'cli-fallback' },
    execution_policy: {
      isolation: 'tool-policy',
      combinations: [
        { access: 'read-only', approval: 'unattended', support: 'native', transports: ['stdio-json'] },
        { access: 'provider-native-development', approval: 'ask-sensitive', support: 'unsupported', transports: ['stdio-json'], reason: 'bridge unavailable' },
        { access: 'unrestricted-host', approval: 'unattended', support: 'native', transports: ['stdio-json'] },
      ],
    },
  }];
  const options = executionPolicyPresets(catalog, 'claude');
  assert.equal(options.find((item) => item.id === 'read-only').disabled, false);
  assert.equal(options.find((item) => item.id === 'controlled-development').disabled, true);
  assert.equal(options.find((item) => item.id === 'controlled-development').reason, 'bridge unavailable');
});
