import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serviceTierLabel,
  serviceTierPayload,
  serviceTierRunLabel,
  serviceTierSourceLabel,
} from './serviceTier.js';

test('labels service tier values and run sources', () => {
  assert.equal(serviceTierLabel(''), '标准');
  assert.equal(serviceTierLabel('priority'), '快速');
  assert.equal(serviceTierSourceLabel('agent_profile'), 'Agent Profile');
  assert.equal(serviceTierRunLabel({
    service_tier: 'priority',
    service_tier_source: 'issue',
  }), '快速 · Issue override');
  assert.equal(serviceTierRunLabel({
    runtime_metadata: { service_tier: 'priority', service_tier_source: 'project' },
  }), '快速 · Project default');
});

test('normalizes service tier request payloads', () => {
  assert.deepEqual(serviceTierPayload(' priority '), { service_tier: 'priority' });
});
