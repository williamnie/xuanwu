import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const assistantSource = readFileSync(new URL('./assistant.js', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('./connectors.js', import.meta.url), 'utf8');

test('PI delegation client exposes active API surface without retired project controls', () => {
  assert.ok(assistantSource.includes("getPiSkills: () => request('/api/pi/skills')"));
  assert.ok(connectorsSource.includes("getPiMcpCapabilities: () => request('/api/pi/mcp/capabilities')"));
  assert.ok(assistantSource.includes('updatePiDelegation: (id, updates) => request(`/api/pi/delegations/${encodeURIComponent(id)}`'));
  assert.ok(assistantSource.includes('expirePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/expire`'));

  assert.doesNotMatch(assistantSource, /getProjectPiSettings:/);
  assert.doesNotMatch(assistantSource, /updateProjectPiSettings:/);
  assert.doesNotMatch(assistantSource, /getProjectPiPolicy:/);
  assert.doesNotMatch(assistantSource, /updateProjectPiPolicy:/);
  assert.doesNotMatch(assistantSource, /pauseProjectPiAutonomousMode:/);
  assert.doesNotMatch(assistantSource, /resumeProjectPiAutonomousMode:/);
});
