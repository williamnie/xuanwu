import assert from 'node:assert/strict';
import test from 'node:test';
import { piConnectionStatus } from './piConnectionStatus.js';

const state = { form: { api: 'openai-codex-responses', apiKey: '', modelId: 'model-a', modelProvider: 'openai-codex' }, oauthStatus: { pi_oauth: { configured: true } } };

test('OAuth authorization does not imply that the model passed a test', () => {
  assert.deepEqual(piConnectionStatus(state), { authorized: true, model: 'untested' });
  assert.deepEqual(piConnectionStatus({ ...state, connectionTest: { providerId: 'openai-codex', result: { ok: false } } }), { authorized: true, model: 'failed' });
  assert.deepEqual(piConnectionStatus({ ...state, connectionTest: { providerId: 'openai-codex', result: { ok: true } } }), { authorized: true, model: 'passed' });
});

test('a different connection or revoked OAuth cannot inherit a passed model status', () => {
  assert.equal(piConnectionStatus({ ...state, connectionTest: { providerId: 'other', result: { ok: true } } }).model, 'untested');
  assert.deepEqual(piConnectionStatus({ ...state, oauthStatus: null, connectionTest: { providerId: 'openai-codex', result: { ok: true } } }), { authorized: false, model: 'untested' });
});

test('unsaved API credentials are not presented as authorized just because they were typed', () => {
  const apiState = { form: { ...state.form, api: 'openai-responses', apiKey: 'new-key' }, selectedProvider: { api_key_configured: true } };
  assert.deepEqual(piConnectionStatus(apiState), { authorized: false, model: 'untested' });
  assert.deepEqual(piConnectionStatus({ ...apiState, connectionTest: { providerId: 'openai-codex', result: { ok: true } } }), { authorized: true, model: 'passed' });
});
