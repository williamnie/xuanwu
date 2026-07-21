import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('./Connections.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const navigationSource = readFileSync(new URL('./settingsNavigation.js', import.meta.url), 'utf8');

test('top-level Connections is an independent product surface', () => {
  assert.match(appSource, /const Connections = lazy\(\(\) => import\('\.\/pages\/Connections'\)\)/);
  assert.match(appSource, /currentPage === 'connections'[\s\S]*<Connections \/>/);
  assert.doesNotMatch(appSource, /currentPage === 'connections'[\s\S]*initialTab="connectors"/);
  assert.match(connectionsSource, /Runtime connectivity/);
  assert.match(connectionsSource, /AI Providers/);
  assert.match(connectionsSource, /PI Agent/);
  assert.match(connectionsSource, /Integrations/);
  assert.match(connectionsSource, /MCP/);
});

test('Connections presents provider then PI Agent configuration and owns connection diagnostics', () => {
  for (const component of ['PiAgentSettingsPanel view="connection"', 'PiAgentSettingsPanel view="agent"', 'ConnectorDiagnosticsPanel', 'FeishuSettingsPanel', 'PiMcpManagementPanel']) {
    assert.match(connectionsSource, new RegExp(component));
  }
  assert.doesNotMatch(connectionsSource, /PiAgentSettingsPanel view="advanced"/);
  assert.doesNotMatch(sectionsSource, /ConnectorDiagnosticsPanel|FeishuSettingsPanel|PiMcpManagementPanel/);
  assert.match(sectionsSource, /PiAgentSettingsPanel view="agent"/);
  assert.doesNotMatch(sectionsSource, /PiAgentSettingsPanel view="advanced"/);
});

test('legacy Settings connection tabs redirect to the product page', () => {
  assert.match(navigationSource, /connections: \{ tier: 'product', tab: 'connections' \}/);
  assert.match(navigationSource, /connectors: \{ tier: 'product', tab: 'connections' \}/);
  assert.doesNotMatch(navigationSource, /\{ id: 'connections', label: 'Connections' \}/);
  assert.doesNotMatch(navigationSource, /\{ id: 'mcp', label: 'MCP' \}/);
  assert.doesNotMatch(navigationSource, /\{ id: 'model-runtime', label: 'Model Runtime' \}/);
});
