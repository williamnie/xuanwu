import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');
const editSource = readFileSync(new URL('../components/IssueEditModal.jsx', import.meta.url), 'utf8');

test('new Issue exposes Agent Profile provider routing and submits the selected profile', () => {
  assert.match(source, /projectsApi\.getAgentProfiles\(\)/);
  assert.match(source, /systemApi\.getProviders\(\)/);
  assert.match(source, /availableAgentProfiles\(agentProfiles, providerCatalog\)/);
  assert.match(source, /<label>Code Agent<\/label>/);
  assert.match(source, /<AgentProfileSelectOptions/);
  assert.match(source, /agent_profile_id:\s*formAgentProfileId/);
});

test('Issue edit keeps an unavailable historical profile while filtering new selections', () => {
  assert.match(editSource, /projectsApi\.getAgentProfiles\(\)/);
  assert.match(editSource, /systemApi\.getProviders\(\)/);
  assert.match(editSource, /historicalSelectionPreserved/);
  assert.match(editSource, /<AgentProfileSelectOptions/);
  assert.match(editSource, /agent_profile_id/);
});
