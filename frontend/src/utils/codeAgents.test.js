import assert from 'node:assert/strict';
import test from 'node:test';
import { availableAgentProfiles, availableCodeAgentIDs, codeAgentAvailable, effectiveProjectProvider } from './codeAgents.js';

const catalog = [
  { id: 'codex', enabled: true, submittable: false },
  { id: 'claude', enabled: true, submittable: true },
  { id: 'pi-coding-agent', enabled: false, submittable: false },
];

test('Code Agent selectors expose only enabled and ready providers', () => {
  assert.deepEqual([...availableCodeAgentIDs(catalog)], ['claude']);
  assert.equal(codeAgentAvailable('claude', catalog), true);
  assert.equal(codeAgentAvailable('codex', catalog), false);
  assert.deepEqual(availableAgentProfiles([
    { id: 'codex-profile', provider: 'codex' },
    { id: 'claude-profile', provider: 'claude' },
    { id: 'pi-profile', provider: 'pi-coding-agent' },
  ], catalog).map((profile) => profile.id), ['claude-profile']);
});

test('project routing resolves its default profile before the project provider', () => {
  assert.equal(effectiveProjectProvider({ provider: 'codex', default_agent_profile_id: 'claude-profile' }, [
    { id: 'claude-profile', provider: 'claude' },
  ]), 'claude');
  assert.equal(effectiveProjectProvider({ provider: 'codex' }, []), 'codex');
});
