import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const authGate = readFileSync(new URL('../components/AuthGate.jsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./RemoteAccessTokenPanel.jsx', import.meta.url), 'utf8');
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const systemApi = readFileSync(new URL('../api/system.js', import.meta.url), 'utf8');

test('first browser connection explains the one-time installer token and its default file', () => {
  assert.match(authGate, /首次连接/);
  assert.match(authGate, /cat ~\/\.local\/state\/xuanwu\/auth_token/);
  assert.match(authGate, /XUANWU_AUTH_TOKEN_FILE/);
  assert.match(authGate, /setAuthToken\(value\)/);
  assert.doesNotMatch(authGate, /window\.(?:alert|confirm)/);
});

test('advanced runtime settings rotate and immediately adopt a file-managed token', () => {
  assert.match(sections, /<RemoteAccessTokenPanel \/>/);
  assert.match(systemApi, /getAuthTokenStatus:[\s\S]*\/api\/auth\/token/);
  assert.match(systemApi, /rotateAuthToken:[\s\S]*\/api\/auth\/token\/rotate/);
  assert.match(panel, /setAuthToken\(result\.token\)/);
  assert.match(panel, /新 token 只显示这一次/);
  assert.match(panel, /旧 token 会立即失效/);
  assert.doesNotMatch(panel, /window\.(?:alert|confirm)/);
});
