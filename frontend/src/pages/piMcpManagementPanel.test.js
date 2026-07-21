import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const panelSource = readFileSync(new URL('./PiMcpManagementPanel.jsx', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('./Connections.jsx', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Connections exposes MCP discovery and enablement management without secret echo', () => {
  assert.match(connectionsSource, /PiMcpManagementPanel/);
  assert.match(panelSource, /Detected MCP servers/);
  assert.match(panelSource, /Manual MCP servers/);
  assert.match(panelSource, /Capabilities/);
  assert.match(panelSource, /发现不等于启用/);
  assert.match(panelSource, /connectorsApi\.scanPiMcpDiscovery/);
  assert.match(panelSource, /connectorsApi\.introspectPiMcpServer/);
  assert.match(panelSource, /\[redacted\]/);
  assert.doesNotMatch(panelSource, /window\.alert|window\.confirm/);
  assert.match(connectorsSource, /scanPiMcpDiscovery:/);
  assert.match(connectorsSource, /\/api\/pi\/mcp\/discovery\/scan/);
  assert.match(connectorsSource, /patchPiMcpCapability:/);
});
