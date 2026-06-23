import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

test('PI delegation client exposes active API surface without retired project controls', () => {
  assert.ok(clientSource.includes("getPiSkills: () => request('/api/pi/skills')"));
  assert.ok(clientSource.includes("getPiMcpCapabilities: () => request('/api/pi/mcp/capabilities')"));
  assert.ok(clientSource.includes('updatePiDelegation: (id, updates) => request(`/api/pi/delegations/${encodeURIComponent(id)}`'));
  assert.ok(clientSource.includes('expirePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/expire`'));

  assert.doesNotMatch(clientSource, /getProjectPiSettings:/);
  assert.doesNotMatch(clientSource, /updateProjectPiSettings:/);
  assert.doesNotMatch(clientSource, /getProjectPiPolicy:/);
  assert.doesNotMatch(clientSource, /updateProjectPiPolicy:/);
  assert.doesNotMatch(clientSource, /pauseProjectPiAutonomousMode:/);
  assert.doesNotMatch(clientSource, /resumeProjectPiAutonomousMode:/);
});
