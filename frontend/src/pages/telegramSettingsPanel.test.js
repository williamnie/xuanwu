import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./TelegramSettingsPanel.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Telegram settings are wired into integrations without secret readback', () => {
  assert.match(sectionsSource, /<TelegramSettingsPanel \/>/);
  assert.match(connectorsSource, /\/api\/integrations\/telegram\/settings/);
  assert.match(connectorsSource, /\/api\/integrations\/telegram\/test-connection/);
  assert.match(connectorsSource, /\/api\/integrations\/telegram\/discover-source/);
  assert.match(panelSource, /bot_token: ''/);
  assert.doesNotMatch(panelSource, /data\?\.bot_token\b/);
});

test('Telegram settings fail closed when configuration could not be loaded', () => {
  assert.match(panelSource, /setRemote\(null\)/);
  assert.match(panelSource, /\['配置未加载'\]/);
  assert.match(panelSource, /disabled=\{!state\.remote \|\| state\.saving\}/);
});

test('Telegram settings do not report disabled or incomplete credentials as configured', () => {
  assert.match(panelSource, /!remote\.bot_token_configured \? 'Bot Token'/);
  assert.match(panelSource, /!\(remote\.allowed_chat_ids \|\| \[\]\)\.length \? '安全来源 Chat ID'/);
  assert.match(panelSource, /!\(remote\.allowed_user_ids \|\| \[\]\)\.length \? '安全来源 User ID'/);
  assert.match(panelSource, /state\.remote\?\.status !== 'configured'/);
  assert.match(panelSource, /Telegram 配置完整，当前未启用/);
});

test('Telegram onboarding discovers and fills source IDs from only a Bot Token', () => {
  assert.match(panelSource, /首次接入只需 Bot Token/);
  assert.match(panelSource, /给 Bot 发送 \/start/);
  assert.match(panelSource, /connectorsApi\.discoverTelegramSource\(state\.form\.bot_token\.trim\(\)\)/);
  assert.match(panelSource, /allowed_chat_ids: mergeCommaValue\(form\.allowed_chat_ids, source\.chat_id\)/);
  assert.match(panelSource, /allowed_user_ids: mergeCommaValue\(form\.allowed_user_ids, source\.user_id\)/);
  assert.match(panelSource, /<details className="telegram-advanced">/);
});
