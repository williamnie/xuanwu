import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableAgentProfiles,
  availableCodeAgentIDs,
  codeAgentAvailable,
  codeAgentLabel,
  effectiveProjectProvider,
  groupedAvailableAgentProfiles,
  unavailableSelectedAgentProfile,
} from './codeAgents.js';

const catalog = [
  { id: 'codex', enabled: true, submittable: false, legacy_capabilities: ['issue_execution'] },
  { id: 'claude', label: 'Claude Code', enabled: true, submittable: true, capabilities: { issueExecution: true } },
  { id: 'pi-coding-agent', enabled: false, submittable: false, legacy_capabilities: ['issue_execution'] },
  { id: 'qoder', label: 'Qoder', enabled: true, submittable: true, legacy_capabilities: ['issue_execution'] },
  { id: 'read-only-viewer', enabled: true, submittable: true, legacy_capabilities: ['sessions'] },
];

test('Code Agent selectors expose only enabled and ready providers', () => {
  assert.deepEqual([...availableCodeAgentIDs(catalog)], ['claude', 'qoder']);
  assert.equal(codeAgentAvailable('claude', catalog), true);
  assert.equal(codeAgentAvailable('codex', catalog), false);
  assert.deepEqual(availableAgentProfiles([
    { id: 'codex-profile', provider: 'codex' },
    { id: 'claude-profile', provider: 'claude' },
    { id: 'pi-profile', provider: 'pi-coding-agent' },
    { id: 'qoder-profile', provider: 'qoder' },
    { id: 'viewer-profile', provider: 'read-only-viewer' },
  ], catalog).map((profile) => profile.id), ['claude-profile', 'qoder-profile']);
});

test('groups selectable profiles by dynamic provider labels and preserves unavailable history', () => {
  const profiles = [
    { id: 'claude-review', name: 'Review', provider: 'claude' },
    { id: 'qoder-built-in', name: 'Qoder local', provider: 'qoder' },
    { id: 'legacy-pi', name: 'Legacy Pi', provider: 'pi-coding-agent' },
  ];
  assert.deepEqual(groupedAvailableAgentProfiles(profiles, catalog), [
    { provider: 'claude', label: 'Claude Code', profiles: [profiles[0]] },
    { provider: 'qoder', label: 'Qoder', profiles: [profiles[1]] },
  ]);
  assert.equal(codeAgentLabel('qoder', catalog), 'Qoder');
  assert.deepEqual(unavailableSelectedAgentProfile('legacy-pi', profiles, catalog), {
    id: 'legacy-pi', name: 'Legacy Pi', provider: 'pi-coding-agent', providerLabel: 'pi-coding-agent',
  });
  assert.equal(unavailableSelectedAgentProfile('qoder-built-in', profiles, catalog), null);
});

test('project routing resolves its default profile before the project provider', () => {
  assert.equal(effectiveProjectProvider({ provider: 'codex', default_agent_profile_id: 'claude-profile' }, [
    { id: 'claude-profile', provider: 'claude' },
  ]), 'claude');
  assert.equal(effectiveProjectProvider({ provider: 'codex' }, []), 'codex');
});
