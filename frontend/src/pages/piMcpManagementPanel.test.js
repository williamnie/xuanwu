import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpServerLifecycleStates } from '../utils/mcpLifecycle.js';

const panelSource = readFileSync(new URL('./PiMcpManagementPanel.jsx', import.meta.url), 'utf8');
const settingsSectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Supervisor Settings exposes MCP discovery and enablement management without secret echo', () => {
  assert.match(settingsSectionsSource, /<PiMcpManagementPanel embedded \/>/);
  assert.match(settingsSectionsSource, /工具与 MCP/);
  assert.match(panelSource, /Detected MCP servers/);
  assert.match(panelSource, /Manual MCP servers/);
  assert.match(panelSource, /Capabilities/);
  assert.match(panelSource, /发现不等于启用/);
  assert.match(panelSource, /仅高危操作询问/);
  assert.match(panelSource, /每次写入都询问/);
  assert.match(panelSource, /只读，禁止写入/);
  assert.match(panelSource, /持续授权/);
  assert.match(panelSource, /connectorsApi\.scanPiMcpDiscovery/);
  assert.match(panelSource, /connectorsApi\.introspectPiMcpServer/);
  assert.match(panelSource, /\[redacted\]/);
  assert.doesNotMatch(panelSource, /window\.alert|window\.confirm/);
  assert.match(connectorsSource, /scanPiMcpDiscovery:/);
  assert.match(connectorsSource, /\/api\/pi\/mcp\/discovery\/scan/);
  assert.match(connectorsSource, /patchPiMcpCapability:/);
  assert.match(connectorsSource, /revokePiMcpApprovalGrant:/);
});

test('MCP lifecycle labels distinguish discovered, enabled, ready, degraded, and disabled', () => {
  assert.deepEqual(mcpServerLifecycleStates({
    enabled: false, readiness: 'not_introspected', status: 'discovered'
  }), ['discovered', 'disabled']);
  assert.deepEqual(mcpServerLifecycleStates({
    enabled: true, readiness: 'ready', status: 'available'
  }), ['enabled', 'ready']);
  assert.deepEqual(mcpServerLifecycleStates({
    enabled: true, readiness: 'failed', status: 'failed'
  }), ['enabled', 'degraded']);
});
