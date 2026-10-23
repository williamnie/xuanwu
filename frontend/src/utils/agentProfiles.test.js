import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentProfilePayload,
  normalizeAgentProfileForm,
  parseIntentText,
  profileIDFromName,
  } from './agentProfiles.js';

test('normalizes profile ids and intent text for API payloads', () => {
  assert.equal(profileIDFromName('Nightly Codex!'), 'nightly-codex');
  assert.deepEqual(parseIntentText('xuanwu, browser\nfigma'), [
    'xuanwu',
    'browser',
    'figma',
  ]);
  const payload = agentProfilePayload({
    name: 'Nightly Codex',
    skill_intents: 'xuanwu, browser',
  });
  assert.equal(payload.id, 'nightly-codex');
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.service_tier, '');
  assert.equal(payload.skill_intents, '["xuanwu","browser"]');
});

test('normalizes editable profile form defaults', () => {
  const form = normalizeAgentProfileForm({ skill_intents: '["a","b"]' });
  assert.equal(form.provider, 'codex');
  assert.equal(form.skill_intents, 'a, b');
  assert.equal(form.service_tier, '');
  assert.equal(agentProfilePayload({ name: 'Pi review', provider: 'pi-coding-agent', model: '' }).model, '');
  assert.equal(normalizeAgentProfileForm({ provider: 'claude', model: 'codex-default' }).model, '');
});


test('editing visible preset fields preserves hidden plugin intents exactly', () => {
  for (const original of [' [ "legacy.plugin", "legacy.plugin" ]\n', 'legacy,unknown-format', '', null, ['keep', 'keep']]) {
    const form = normalizeAgentProfileForm({ id: 'existing', name: 'Before', plugin_intents: original });
    const payload = agentProfilePayload({ ...form, name: 'After', skill_intents: 'browser' });
    assert.deepEqual(form.plugin_intents, original);
    assert.deepEqual(payload.plugin_intents, original);
    assert.equal(payload.skill_intents, '["browser"]');
    assert.equal(payload.name, 'After');
  }
  assert.equal(agentProfilePayload({ name: 'New preset' }).plugin_intents, '[]');
});
