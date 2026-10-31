import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableAgentProfiles,
  availableCodeAgentIDs,
  codeAgentAvailable,
  agentProfileOptionLabel,
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

test('node catalog is authoritative, including tools absent from center and offline readiness', () => {
  const nodeCatalog = [{ id: 'node-only', label: 'Node Tool', enabled: true, submittable: true,
    capabilities: { issueExecution: true }, node_id: 'node-a', node_online: false, runtime: { ready: false } }];
  const profiles = [{ id: 'remote', name: 'Remote preset', provider: 'node-only' }, { id: 'local', provider: 'claude' }];
  assert.deepEqual(availableAgentProfiles(profiles, nodeCatalog), [profiles[0]]);
  assert.deepEqual(groupedAvailableAgentProfiles(profiles, nodeCatalog), [
    { provider: 'node-only', label: 'Node Tool', profiles: [profiles[0]] },
  ]);
  assert.equal(unavailableSelectedAgentProfile('local', profiles, nodeCatalog).id, 'local');
  assert.equal(unavailableSelectedAgentProfile('remote', profiles, nodeCatalog), null);
  assert.deepEqual(availableAgentProfiles(profiles, catalog), [profiles[1]]);
  assert.deepEqual(availableAgentProfiles(profiles, []), []);
});

test('preset option text names node config for builtin presets in a node catalog only', () => {
  const nodeCatalog = [{ id: 'claude', label: 'hermes · Claude Code', node_id: 'node-a' }];
  const builtin = { id: 'xuanwu-provider-claude', name: 'Claude Code（本机配置）', provider: 'claude' };
  assert.equal(agentProfileOptionLabel(builtin, nodeCatalog), 'Claude Code（节点配置） · 节点默认模型');
  assert.equal(agentProfileOptionLabel(builtin, catalog), 'Claude Code（本机配置） · 编程工具默认模型');
  assert.equal(agentProfileOptionLabel({ id: 'mine', name: '我的（本机配置）', provider: 'claude', model: 'opus' }, nodeCatalog), '我的（本机配置） · opus');
});
