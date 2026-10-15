import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexLoginReuse } from './PiAgentSettingsPanel.jsx';
import { credentialReady, credentialSourcePayload, recommendCodexLogin, sourceForForm, sourceMatches, codexLoginMessage } from './piCredentialSource.js';
import { piConnectionStatus } from './piConnectionStatus.js';
import { translate } from '../i18n/translations.js';
import { I18nContext } from '../i18n/context.js';

const form = { api: 'openai-codex-responses', credentialSource: 'codex_login', modelProvider: 'openai-codex', modelId: 'fixture', apiKey: '' };
const status = { pi_oauth: { configured: true }, codex_login: { configured: true, available: false } };

test('selected source controls authorization independently of a previously passed model test', () => {
  assert.equal(credentialReady(form, status), false);
  assert.equal(credentialReady({ ...form, credentialSource: 'stored' }, status), true);
  assert.deepEqual(piConnectionStatus({ form, oauthStatus: status, connectionTest: { providerId: 'openai-codex', credentialSource: 'stored', result: { ok: true } } }), { authorized: false, model: 'untested' });
  assert.deepEqual(piConnectionStatus({ form, oauthStatus: { ...status, codex_login: { available: true } } }), { authorized: true, model: 'untested' });
  assert.equal(sourceMatches(form, { credentialSource: 'stored' }), false);
});

test('only unconfigured onboarding can recommend reuse; existing stored settings stay stored', () => {
  const available = { codex_login: { available: true } };
  assert.equal(recommendCodexLogin({}, [], available), true);
  assert.equal(recommendCodexLogin({}, [{ api_key_configured: true }], available), false);
  assert.equal(recommendCodexLogin({}, [], { ...available, pi_oauth: { configured: true } }), false);
  assert.equal(recommendCodexLogin({}, [], status), false);
  assert.equal(recommendCodexLogin({ credential_source: 'codex_login' }, [], available), false);
  assert.equal(sourceForForm({ ...form, api: 'openai-responses' }), 'stored');
});

test('test source payload is an enum without credentials, and errors map to localized safe copy', () => {
  assert.deepEqual(credentialSourcePayload(form), { credential_source: 'codex_login' });
  assert.deepEqual(credentialSourcePayload({ ...form, api: 'openai-responses' }), {});
  for (const error of ['codex_login_unsupported', 'codex_login_home_mismatch', 'codex_login_refresh_failed', 'codex_provider_disabled', 'codex_login_expired']) {
    const key = codexLoginMessage({ error });
    assert.notEqual(translate('zh-CN', key), key);
    assert.notEqual(translate('en-US', key), key);
  }
});

test('reuse UI exposes status and switching without rendering independent login/logout or private fields', () => {
  const state = { form, oauthStatus: { codex_login: { available: true, email: 'synthetic@example.invalid', account_id: 'synthetic-account', token: 'synthetic-token', path: '/synthetic/private' } } };
  const html = renderToStaticMarkup(<CodexLoginReuse state={state} />);
  assert.match(html, /使用 Codex 的登录 · 可用/);
  assert.match(html, /改用独立登录/);
  assert.match(html, /先完成独立登录，再保存连接/);
  assert.doesNotMatch(html, /synthetic|撤销授权|重新授权|auth_url/);
  const english = renderToStaticMarkup(<I18nContext.Provider value={{ t: key => translate('en-US', key) }}><CodexLoginReuse state={state} /></I18nContext.Provider>);
  assert.match(english, /Use independent sign-in/);
});

test('runtime form writes source only when saved, and guards delayed discovery/test results after a source switch', () => {
  const source = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
  const selection = source.slice(source.indexOf('const selectCodexLogin'), source.indexOf('const discoverModels'));
  assert.match(selection, /invalidateConnectionTest/);
  assert.match(selection, /setForm/);
  assert.doesNotMatch(selection, /assistantApi\.|saveSupervisor|discoverPiModels/);
  assert.match(source, /credential_source: sourceForForm\(form\)/);
  assert.match(source, /onboarding && recommendCodexLogin/);
  assert.match(source, /sourceForForm\(nextForm\) !== 'codex_login'/);
  const discovery = source.slice(source.indexOf('async function discoverPiModels'), source.indexOf('async function deletePiProviderConnection'));
  assert.match(discovery, /if \(!isCurrent\(\)\) return/);
  assert.match(discovery, /explicit \? credentialSourcePayload\(form\)/);
  assert.match(discovery, /credentialSourcePayload\(form\)/);
});
