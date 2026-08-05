import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentProfilePayload,
  issueRunProfileLabel,
  runCapabilitySummary,
  runSelectionReasonLabel,
  normalizeAgentProfileForm,
  parseIntentText,
  profileIDFromName,
  summarizeAgentProfile,
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

test('summarizes configured and missing agent profiles honestly', () => {
  assert.equal(summarizeAgentProfile(null), '未配置，沿用项目执行参数');
  assert.equal(
    summarizeAgentProfile({ id: 'nightly', name: 'Nightly', provider: 'codex', model: 'gpt-5.5', reasoning_effort: 'high', service_tier: 'priority' }),
    'Nightly · codex · gpt-5.5 · effort:high · speed:priority',
  );
  assert.equal(
    issueRunProfileLabel({ agent_profile_id: 'nightly' }, { default_agent_profile: { id: 'nightly', name: 'Nightly' } }),
    'Nightly (nightly)',
  );
  assert.equal(
    issueRunProfileLabel({ agent_profile_id: 'override' }, {}, [{ id: 'override', name: 'Override' }]),
    'Override (override)',
  );
  assert.equal(
    issueRunProfileLabel(
      { id: 'run-1', agent_profile_id: '' },
      { default_agent_profile_id: 'current-default' },
    ),
    '未配置',
  );
  assert.equal(issueRunProfileLabel({}, {}), '未配置');
});

test('labels run dispatcher metadata compactly', () => {
  assert.equal(runSelectionReasonLabel('issue_override'), 'Issue override');
  assert.equal(runSelectionReasonLabel('project_default'), 'Project default');
  assert.equal(runSelectionReasonLabel('provider_default'), 'Provider default');
  assert.equal(runCapabilitySummary({ capability_summary: 'issue_execution,sessions' }), 'issue_execution, sessions');
  assert.equal(runCapabilitySummary({ capabilities: ['issue_execution'] }), 'issue_execution');
  assert.equal(runCapabilitySummary({}), '未记录');
});

test('normalizes editable profile form defaults', () => {
  const form = normalizeAgentProfileForm({ skill_intents: '["a","b"]' });
  assert.equal(form.provider, 'codex');
  assert.equal(form.skill_intents, 'a, b');
  assert.equal(form.service_tier, '');
  assert.equal(agentProfilePayload({ name: 'Pi review', provider: 'pi-coding-agent', model: '' }).model, '');
  assert.equal(normalizeAgentProfileForm({ provider: 'claude', model: 'codex-default' }).model, '');
});
