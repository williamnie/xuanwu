import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');

test('new Issue exposes Agent Profile provider routing and submits the selected profile', () => {
  assert.match(source, /projectsApi\.getAgentProfiles\(\)/);
  assert.match(source, /<label>Code Agent<\/label>/);
  assert.match(source, /provider === 'pi-coding-agent'\) return 'Pi'/);
  assert.match(source, /agent_profile_id:\s*formAgentProfileId/);
});
