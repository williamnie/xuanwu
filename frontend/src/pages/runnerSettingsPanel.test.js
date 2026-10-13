import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./RunnerSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const systemSource = readFileSync(new URL('../api/system.js', import.meta.url), 'utf8');

test('Settings exposes Runner global concurrency controls backed by runner settings API', () => {
  assert.match(settingsSource, /SettingsTabContent/);
  assert.match(sectionsSource, /RunnerSettingsPanel/);
  assert.match(sectionsSource, /<RunnerSettingsPanel \/>/);
  assert.match(panelSource, /max_parallel_projects/);
  // Codex 运行方式与命令只在 AI 连接 → Codex 一处配置；这里只提交并发数，避免两处表单互相覆盖。
  assert.doesNotMatch(panelSource, /codex_server_mode|codex_app_command|codex_cli_command|首次使用启动器/);
  assert.match(panelSource, /systemApi\.getRunnerSettings/);
  assert.match(panelSource, /systemApi\.updateRunnerSettings/);
  assert.match(systemSource, /getRunnerSettings:/);
  assert.match(systemSource, /updateRunnerSettings:/);
  assert.match(systemSource, /\/api\/runner\/settings/);
});
