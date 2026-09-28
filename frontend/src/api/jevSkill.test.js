import assert from 'node:assert/strict';
import test from 'node:test';
import { jevSkillApi } from './jevSkill.js';

test('Jev settings persist through PUT; testing sends the current draft to a separate endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ ok: false, status: 'fallback', reason: 'missing_key' }), { status: 200 });
  };
  try {
    const draft = { enabled: true, mode: 'assist', scopes: ['web'], api_key: 'draft-secret' };
    await jevSkillApi.get();
    await jevSkillApi.save({ clear_api_key: true });
    const result = await jevSkillApi.test(draft);
    assert.equal(result.ok, false);
    assert.deepEqual(requests, [
      { url: '/api/pi/skills/jev-assist/settings', method: 'GET', body: null },
      { url: '/api/pi/skills/jev-assist/settings', method: 'PUT', body: { clear_api_key: true } },
      { url: '/api/pi/skills/jev-assist/test', method: 'POST', body: draft },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
