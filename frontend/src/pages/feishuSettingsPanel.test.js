import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./FeishuSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsSectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Settings Integrations exposes a Feishu bot configuration panel backed by integration settings API', () => {
  assert.match(settingsSectionsSource, /<FeishuSettingsPanel \/>/);
  assert.match(settingsSectionsSource, /IntegrationsSettingsTab/);
  assert.match(panelSource, /飞书 Bot/);
  assert.match(panelSource, /长连接/);
  assert.match(panelSource, /无需公网域名/);
  assert.match(panelSource, /App ID/);
  assert.match(panelSource, /App Secret/);
  assert.match(panelSource, /Verification Token/);
  assert.match(panelSource, /Encrypt Key/);
  assert.match(panelSource, /Allowed Chat IDs/);
  assert.match(panelSource, /Default Chat ID/);
  assert.match(panelSource, /Default User ID/);
  assert.match(panelSource, /Project Mappings/);
  assert.match(panelSource, /connectorsApi\.getFeishuSettings/);
  assert.match(panelSource, /connectorsApi\.updateFeishuSettings/);
  assert.match(panelSource, /receive_mode/);
  assert.match(connectorsSource, /getFeishuSettings:/);
  assert.match(connectorsSource, /updateFeishuSettings:/);
  assert.match(connectorsSource, /\/api\/integrations\/feishu\/settings/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});
