import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./FeishuSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');

test('Settings exposes a Feishu bot configuration panel backed by integration settings API', () => {
  assert.match(settingsSource, /FeishuSettingsPanel/);
  assert.match(panelSource, /飞书 Bot/);
  assert.match(panelSource, /App ID/);
  assert.match(panelSource, /App Secret/);
  assert.match(panelSource, /Verification Token/);
  assert.match(panelSource, /Encrypt Key/);
  assert.match(panelSource, /Allowed Chat IDs/);
  assert.match(panelSource, /Project Mappings/);
  assert.match(panelSource, /api\.getFeishuSettings/);
  assert.match(panelSource, /api\.updateFeishuSettings/);
  assert.match(clientSource, /getFeishuSettings:/);
  assert.match(clientSource, /updateFeishuSettings:/);
  assert.match(clientSource, /\/api\/integrations\/feishu\/settings/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});
