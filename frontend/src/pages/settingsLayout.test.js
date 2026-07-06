import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const placeholderSource = readFileSync(new URL('./AssistantSettingsPlaceholders.jsx', import.meta.url), 'utf8');
const connectorDiagnosticsSource = readFileSync(new URL('./ConnectorDiagnosticsPanel.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');

test('Settings groups panels behind Assistant Settings tabs and removes duplicate cron panel', () => {
  assert.match(settingsSource, /useState\('assistant'\)/);
  assert.match(sectionsSource, /activeTab === 'assistant'/);
  assert.match(sectionsSource, /activeTab === 'runner-brain'/);
  assert.match(sectionsSource, /activeTab === 'connectors'/);
  assert.match(sectionsSource, /activeTab === 'skills'/);
  assert.match(sectionsSource, /activeTab === 'automations'/);
  assert.match(sectionsSource, /activeTab === 'approvals'/);
  assert.match(sectionsSource, /activeTab === 'memory'/);
  assert.match(sectionsSource, /activeTab === 'activity'/);
  assert.doesNotMatch(settingsSource, /CronTasksPanel/);
  assert.doesNotMatch(chromeSource, /Cron 任务已在侧边栏/);
});

test('Assistant Settings IA reserves future capability placeholders', () => {
  assert.match(chromeSource, /Assistant Settings/);
  assert.match(chromeSource, /PI Assistant · Single Runtime/);
  assert.match(placeholderSource, /Single Assistant Runtime/);
  assert.match(placeholderSource, /不恢复多个独立 PI agent/);
  assert.match(sectionsSource, /Connectors/);
  assert.match(sectionsSource, /Skills/);
  assert.match(sectionsSource, /Automations/);
  assert.match(sectionsSource, /Approvals/);
  assert.match(sectionsSource, /Memory/);
  assert.match(sectionsSource, /Activity/);
});

test('Settings restart action is a red in-page danger control', () => {
  assert.match(chromeSource, /settings-danger-button/);
  assert.match(chromeSource, /settings-restart-confirm/);
  assert.ok(stylesSource.includes('.settings-danger-button'));
  assert.ok(stylesSource.includes('var(--error)'));
  assert.doesNotMatch(chromeSource, /window\\.confirm|window\\.alert/);
});

test('Connectors tab shows read-only connector diagnostics from API', () => {
  assert.match(sectionsSource, /ConnectorDiagnosticsPanel/);
  assert.match(apiSource, /getPiConnectors:\s*\(\)\s*=>\s*request\('\/api\/pi\/connectors'\)/);
  assert.match(connectorDiagnosticsSource, /api\.getPiConnectors\(\)/);
  assert.match(connectorDiagnosticsSource, /Connector Diagnostics/);
  assert.doesNotMatch(connectorDiagnosticsSource, /window\.confirm|window\.alert/);
});
