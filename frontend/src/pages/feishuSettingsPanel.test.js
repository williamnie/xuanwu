import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { connectorsApi } from '../api/connectors.js';
import { translate } from '../i18n/translations.js';

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

test('Feishu keeps every field within the three explained groups in both languages', () => {
  for (const label of ['应用凭据', 'App credentials', '事件订阅', 'Event subscription', '通知目标', 'Notification targets']) assert.ok(panelSource.includes(label), label);
  assert.equal((panelSource.match(/<FieldGroup title=/g) || []).length, 3);
  assert.equal((panelSource.match(/description=\{english \?/g) || []).length, 3);
  const credentials = panelSource.slice(panelSource.indexOf('<FieldGroup title='), panelSource.indexOf('</FieldGroup>'));
  assert.match(credentials, /App ID/);
  assert.match(credentials, /App Secret/);
  const events = panelSource.slice(panelSource.indexOf("'Event subscription'"), panelSource.indexOf("'Notification targets'"));
  for (const field of ['receive_mode', 'verification_token', 'encrypt_key', 'allowed_chat_ids', 'allowed_user_ids', 'project_mappings']) assert.ok(events.includes(field), field);
  const targets = panelSource.slice(panelSource.indexOf("'Notification targets'"), panelSource.indexOf('<Footer remote='));
  assert.match(targets, /default_chat_id/);
  assert.match(targets, /default_user_id/);
});

test('Feishu discovery sends no draft settings and leaves saving as a separate action', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, sources: [] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await connectorsApi.discoverFeishuSource({ app_secret: 'unsaved' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/integrations\/feishu\/discover-source$/);
    assert.deepEqual(calls[0], { url: calls[0].url, method: 'POST', body: {} });
  } finally { globalThis.fetch = previousFetch; }
  const discovery = panelSource.slice(panelSource.indexOf('const discover = async'), panelSource.indexOf('const chooseSource ='));
  assert.match(discovery, /connectorsApi\.discoverFeishuSource\(\)/);
  assert.doesNotMatch(discovery, /setForm|updateFeishuSettings/);
  assert.match(panelSource, /const chooseSource = \(source, choice\) => setForm\(current => appendFeishuSource\(current, source, choice\)\)/);
  assert.match(panelSource, /type="checkbox"/);
  assert.match(panelSource, /className="btn btn-secondary"[^>]*onClick=\{discover\} type="button"/);
  for (const key of ['sourceHistory', 'sourceSaveHint', 'noSources', 'private', 'group', 'userId', 'chatId']) {
    const id = `feishu.${key}`;
    assert.notEqual(translate('zh-CN', id), id);
    assert.notEqual(translate('en-US', id), id);
  }
});

test('Feishu renders independent grant choices and explains whole-group and empty-user permissions in both languages', () => {
  assert.match(panelSource, /feishuSourceChoices\(source\)\.map\(choice/);
  assert.match(panelSource, /feishuSourceIncluded\(form, source, choice\)/);
  assert.match(panelSource, /chooseSource\(source, choice\)/);
  assert.match(panelSource, /choice === 'user' \? 'feishu.allowUser' : 'feishu.allowGroup'/);
  assert.match(panelSource, /choice === 'chat' \? <span[^>]*>\{t\('feishu.groupScopeHint'\)\}/);
  assert.match(panelSource, /feishuUsersEmpty\(form\) \? <p[^>]*role="note">\{t\('feishu.emptyUsersHint'\)\}/);
  for (const key of ['allowUser', 'allowGroup', 'groupScopeHint', 'emptyUsersHint']) {
    const id = `feishu.${key}`;
    assert.notEqual(translate('zh-CN', id), id);
    assert.notEqual(translate('en-US', id), id);
  }
  assert.equal(translate('zh-CN', 'feishu.groupScopeHint'), '群内所有成员的消息都会交给玄武处理');
  assert.equal(translate('zh-CN', 'feishu.emptyUsersHint'), '用户名单为空时，所有人都能操作审批卡片；加入第一个用户后，只有名单内的用户可以操作');
});
