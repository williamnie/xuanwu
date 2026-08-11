import assert from 'node:assert/strict';
import test from 'node:test';

import { editorDraft, effectiveProfilePreview, workProfileSummary } from './workProfileRouting.js';

const profiles = [
  { id: 'codex-default', name: 'Codex Default', provider: 'codex', model: 'gpt-5.6' },
  { id: 'claude-work', name: 'Claude Work', provider: 'claude', model: 'claude-sonnet' },
  { id: 'pi-local', name: 'Pi Local', provider: 'pi-coding-agent', model: '' },
];
const project = { id: 'demo', provider: 'codex', model: 'codex-default', default_agent_profile_id: 'codex-default' };

test('Work editor preserves explicit Agent Profile and resolves inherited/default routing', () => {
  const draft = editorDraft({
    agent_profile_id: 'claude-work',
    owner: { project_id: 'demo' },
  }, [project]);
  assert.equal(draft.agent_profile_id, 'claude-work');
  assert.deepEqual(effectiveProfilePreview('', project, profiles), { ...profiles[0], source: 'project_default' });
  assert.deepEqual(effectiveProfilePreview('claude-work', project, profiles), { ...profiles[1], source: 'work' });
});

test('Work detail distinguishes effective selection from latest Run actual provider', () => {
  assert.deepEqual(workProfileSummary({
    agent_profile_id: 'claude-work',
    effective_provider: 'claude',
    effective_agent_profile: { id: 'claude-work', name: 'Claude Work', model: 'claude-sonnet', source: 'work' },
  }, { provider: 'codex' }), {
    selection: 'claude-work',
    effectiveProfile: 'Claude Work',
    effectiveProvider: 'claude',
    effectiveModel: 'claude-sonnet',
    source: 'work',
    runProvider: 'codex',
  });
});

test('Work detail renders an empty provider-scoped model as provider default', () => {
  assert.equal(workProfileSummary({
    agent_profile_id: 'pi-local',
    effective_provider: 'pi-coding-agent',
    effective_agent_profile: { id: 'pi-local', name: 'Pi Local', model: '', source: 'work' },
  }, { provider: 'pi-coding-agent' }).effectiveModel, 'provider default');
});
