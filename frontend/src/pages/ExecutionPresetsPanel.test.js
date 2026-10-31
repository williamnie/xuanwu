import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('./ExecutionPresetsPanel.jsx', import.meta.url), 'utf8');
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');

test('presets mount through the shared lazy advanced section and retain drafts when collapsed', () => {
  assert.match(sections, /presets: <ExecutionPresetsPanel \/>/);
  assert.match(sections, /visited\.has\(id\) \? <div[^>]*>\{content\[id\]\}/);
  assert.match(sections, /element\.open = true/);
  assert.match(sections, /element\.scrollIntoView/);
});

test('preset editing preserves policy validation and project assignment only writes its preset id', () => {
  assert.match(panel, /agentProfilePayload\(form\)/);
  assert.match(panel, /normalizeAgentProfileForm\(profile\)/);
  assert.match(panel, /resolveProviderExecutionPolicy\(payload\.provider/);
  assert.match(panel, /updateAgentProfile\(payload\.id, payload\)/);
  assert.match(panel, /createAgentProfile\(payload\)/);
  assert.match(panel, /updateProject\(projectID, \{ default_agent_profile_id: profileID \}\)/);
  assert.match(panel, /availableAgentProfiles\(profiles, assignmentCatalog\.catalog\)/);
  assert.match(panel, /<AgentProfileSelectOptions/);
});
