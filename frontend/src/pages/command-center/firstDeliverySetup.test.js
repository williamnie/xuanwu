import assert from 'node:assert/strict';
import test from 'node:test';
import { codexImportFailure, createFirstDeliveryConnectionCheck, projectPathFeedback } from './firstDeliverySetup.js';

function fixture(overrides = {}) {
  const calls = [];
  const api = {
    getPiSupervisor: async () => ({ enabled: 1, model_provider: 'saved', model_id: 'model' }),
    getPiProviderSettings: async () => ({ providers: [{ id: 'saved', api: 'openai-responses', base_url: 'https://example.invalid/v1', api_key_configured: true }] }),
    getPiCodexOAuthStatus: async () => ({ pi_oauth: { configured: true } }),
    testPiProviderConnection: async (...args) => { calls.push(args); return { ok: true }; },
    ...overrides,
  };
  return { api, calls };
}

test('saved assistant tests once across effect replay, refresh and returning to the guide, without saving credentials', async () => {
  const { api, calls } = fixture();
  const check = createFirstDeliveryConnectionCheck(api);
  const results = await Promise.all([check(), check()]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  await check();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['saved', { api: 'openai-responses', base_url: 'https://example.invalid/v1', models: 'model', user_agent: '' }]);
  assert.equal(Object.hasOwn(calls[0][1], 'api_key'), false);
});

test('unconfigured and disabled assistants stay in setup with no automatic connection test', async () => {
  for (const overrides of [{ getPiProviderSettings: async () => ({ providers: [] }) }, { getPiProviderSettings: async () => ({ providers: [{ id: 'saved', base_url: 'https://example.invalid', api_key_configured: false }] }) }, { getPiSupervisor: async () => ({ enabled: 0, model_provider: 'saved', model_id: 'model' }) }]) {
    const { api, calls } = fixture(overrides);
    assert.equal(await createFirstDeliveryConnectionCheck(api)(), null);
    assert.equal(calls.length, 0);
  }
});

test('OAuth readiness uses the assistant credential and only the existing connection test', async () => {
  const { api, calls } = fixture({ getPiSupervisor: async () => ({ enabled: 1, model_provider: 'openai-codex', model_id: 'model' }) });
  assert.deepEqual(await createFirstDeliveryConnectionCheck(api)(), { ok: true });
  assert.equal(calls[0][0], 'openai-codex');
  assert.equal(calls[0][1].api, 'openai-codex-responses');
  api.getPiCodexOAuthStatus = async () => ({ pi_oauth: { configured: false } });
  assert.equal(await createFirstDeliveryConnectionCheck(api)(), null);
  assert.equal(calls.length, 1);
});

test('automatic failures do not poll; a manual successful save supersedes the failed check', async () => {
  let calls = 0;
  const { api } = fixture({ testPiProviderConnection: async () => { calls++; throw new Error('unavailable'); } });
  const check = createFirstDeliveryConnectionCheck(api);
  assert.equal((await check()).ok, false);
  assert.equal((await check()).ok, false);
  assert.equal(calls, 1);
  check.remember({ ok: true });
  assert.deepEqual(await check(), { ok: true });
  assert.equal(calls, 1);
});

test('path feedback separates missing, non-directory, non-Git and already registered paths', () => {
  assert.match(projectPathFeedback({ exists: false }), /不存在/);
  assert.match(projectPathFeedback({ exists: true, directory: false }), /是文件/);
  assert.match(projectPathFeedback({ exists: true, directory: true }), /Git 仓库/);
  assert.match(projectPathFeedback({ exists: true, directory: true, git_repo: true }), /可以添加/);
  assert.match(projectPathFeedback({ exists: true, directory: true, git_repo: true, existing_project_id: 'demo' }), /已有项目/);
});

test('Codex import failures explain missing, unreadable and malformed local workspace records', () => {
  assert.match(codexImportFailure(new Error('ENOENT')), /未找到本机/);
  assert.match(codexImportFailure(new Error('EACCES')), /访问权限/);
  assert.match(codexImportFailure(new Error('JSON Parse error')), /记录无法读取/);
  assert.match(codexImportFailure(new Error('unavailable')), /稍后重试/);
});
