import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

test('PI delegation and policy client exposes complete API surface', () => {
  assert.ok(clientSource.includes('getProjectPiPolicy: (id) => request(`/api/projects/${encodeURIComponent(id)}/pi-policy`)'));
  assert.ok(clientSource.includes('updateProjectPiPolicy: (id, updates) => request(`/api/projects/${encodeURIComponent(id)}/pi-policy`'));
  assert.ok(clientSource.includes("getPiSkills: () => request('/api/pi/skills')"));
  assert.ok(clientSource.includes("getPiMcpCapabilities: () => request('/api/pi/mcp/capabilities')"));
  assert.ok(clientSource.includes('updatePiDelegation: (id, updates) => request(`/api/pi/delegations/${encodeURIComponent(id)}`'));
  assert.ok(clientSource.includes('expirePiDelegation: (id) => request(`/api/pi/delegations/${encodeURIComponent(id)}/expire`'));
});
