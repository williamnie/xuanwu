import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./RunnerSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');

test('Settings exposes Runner global concurrency controls backed by runner settings API', () => {
  assert.match(settingsSource, /RunnerSettingsPanel/);
  assert.match(settingsSource, /<RunnerSettingsPanel \/>/);
  assert.match(panelSource, /max_parallel_projects/);
  assert.match(panelSource, /codex_server_mode/);
  assert.match(panelSource, /codex_app_command/);
  assert.match(panelSource, /codex_cli_status/);
  assert.match(panelSource, /首次使用启动器/);
  assert.match(panelSource, /Codex App/);
  assert.match(panelSource, /api\.getRunnerSettings/);
  assert.match(panelSource, /api\.updateRunnerSettings/);
  assert.match(clientSource, /getRunnerSettings:/);
  assert.match(clientSource, /updateRunnerSettings:/);
  assert.match(clientSource, /\/api\/runner\/settings/);
});
