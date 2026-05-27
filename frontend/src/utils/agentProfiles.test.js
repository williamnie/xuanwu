import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentProfilePayload,
  issueRunProfileLabel,
  normalizeAgentProfileForm,
  parseIntentText,
  profileIDFromName,
  summarizeAgentProfile,
} from './agentProfiles.js';

test('normalizes profile ids and intent text for API payloads', () => {
  assert.equal(profileIDFromName('Nightly Codex!'), 'nightly-codex');
  assert.deepEqual(parseIntentText('codex-issue-runner, browser\nfigma'), [
    'codex-issue-runner',
    'browser',
    'figma',
  ]);
  const payload = agentProfilePayload({
    name: 'Nightly Codex',
    skill_intents: 'codex-issue-runner, browser',
  });
  assert.equal(payload.id, 'nightly-codex');
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.skill_intents, '["codex-issue-runner","browser"]');
});

test('summarizes configured and missing agent profiles honestly', () => {
  assert.equal(summarizeAgentProfile(null), '未配置，沿用项目执行参数');
  assert.equal(
    summarizeAgentProfile({ id: 'nightly', name: 'Nightly', provider: 'codex', model: 'gpt-5.5', reasoning_effort: 'high' }),
    'Nightly · codex · gpt-5.5 · effort:high',
  );
  assert.equal(
    issueRunProfileLabel({ agent_profile_id: 'nightly' }, { default_agent_profile: { id: 'nightly', name: 'Nightly' } }),
    'Nightly (nightly)',
  );
  assert.equal(issueRunProfileLabel({}, {}), '未配置');
});

test('normalizes editable profile form defaults', () => {
  const form = normalizeAgentProfileForm({ skill_intents: '["a","b"]' });
  assert.equal(form.provider, 'codex');
  assert.equal(form.skill_intents, 'a, b');
});
