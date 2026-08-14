import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const authGate = readFileSync(new URL('../components/AuthGate.jsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./RemoteAccessTokenPanel.jsx', import.meta.url), 'utf8');
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const systemApi = readFileSync(new URL('../api/system.js', import.meta.url), 'utf8');
const appStyles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('first browser connection explains macOS and Linux token locations', () => {
  assert.match(authGate, /首次连接/);
  assert.match(authGate, /macOS · 源码部署/);
  assert.match(authGate, /Library\/Application Support\/xuanwu-bun-live\/state\/auth_token/);
  assert.match(authGate, /macOS · Release 安装器/);
  assert.match(authGate, /Linux · Release 安装器 \/ systemd/);
  assert.match(authGate, /\.local\/state\/xuanwu\/auth_token/);
  assert.match(authGate, /XUANWU_AUTH_TOKEN_FILE/);
  assert.match(authGate, /XUANWU_STATE_DIR/);
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

test('token visibility control stays centered when global button hover removes transforms', () => {
  const visibilityRule = appStyles.match(/\.auth-token-visibility\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(visibilityRule, /bottom:\s*0/);
  assert.match(visibilityRule, /margin-block:\s*auto/);
  assert.match(visibilityRule, /top:\s*0/);
  assert.doesNotMatch(visibilityRule, /transform:/);
});
