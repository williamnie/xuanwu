import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');

test('Settings groups panels behind tabs and removes duplicate cron panel', () => {
  assert.match(settingsSource, /activeTab === 'runtime'/);
  assert.match(settingsSource, /activeTab === 'agent'/);
  assert.match(settingsSource, /activeTab === 'integrations'/);
  assert.match(settingsSource, /activeTab === 'templates'/);
  assert.doesNotMatch(settingsSource, /CronTasksPanel/);
  assert.doesNotMatch(chromeSource, /Cron 任务已在侧边栏/);
});

test('Settings restart action is a red in-page danger control', () => {
  assert.match(chromeSource, /settings-danger-button/);
  assert.match(chromeSource, /settings-restart-confirm/);
  assert.ok(stylesSource.includes('.settings-danger-button'));
  assert.ok(stylesSource.includes('var(--error)'));
  assert.doesNotMatch(chromeSource, /window\\.confirm|window\\.alert/);
});
