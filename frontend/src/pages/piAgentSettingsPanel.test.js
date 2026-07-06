import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');

test('PI Agent Settings exposes runtime prompt summary debug without secret echo', () => {
  assert.match(panelSource, /当前生效 Prompt 摘要/);
  assert.match(panelSource, /不回显 API key\/token/);
  assert.match(panelSource, /Custom instructions:/);
  assert.match(panelSource, /state\.loadPromptSummary/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(clientSource, /getPiAgentRuntimePrompt:/);
  assert.match(clientSource, /\/api\/pi\/agents\/\$\{encodeURIComponent\(id\)\}\/runtime-prompt/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('PI Agent Settings exposes OpenAI Codex OAuth and user agent controls', () => {
  assert.match(panelSource, /Codex OAuth/);
  assert.match(panelSource, /复制登录地址/);
  assert.match(panelSource, /state\.oauthStatus\?\.auth_url/);
  assert.match(panelSource, /openai-codex-responses/);
  assert.match(panelSource, /startPiCodexOAuthLogin/);
  assert.match(stateSource, /copyPiCodexOAuthUrl/);
  assert.doesNotMatch(stateSource, /openOAuthUrl\\(result\\.auth_url\\)/);
  assert.match(panelSource, /User-Agent/);
  assert.match(stateSource, /getPiCodexOAuthStatus/);
  assert.match(stateSource, /startPiCodexOAuthLogin/);
  assert.match(stateSource, /logoutPiCodexOAuth/);
  assert.match(clientSource, /getPiCodexOAuthStatus:/);
  assert.match(clientSource, /\/api\/pi\/oauth\/openai-codex\/status/);
  assert.match(clientSource, /\/api\/pi\/oauth\/openai-codex\/login/);
});

test('PI Assistant settings no longer expose multi-agent creation controls', () => {
  assert.match(panelSource, /PI Assistant/);
  assert.match(panelSource, /PI Assistant · Runtime/);
  assert.doesNotMatch(panelSource, /Runner Brain/);
  assert.match(panelSource, /不会创建多个独立 agent/);
  assert.doesNotMatch(panelSource, /label="Agent ID"/);
  assert.doesNotMatch(panelSource, /Runner Agent Settings/);
  assert.doesNotMatch(stateSource, /api\.createPiAgent/);
  assert.doesNotMatch(clientSource, /createPiAgent:/);
  assert.match(stateSource, /api\.updatePiAgent\(DEFAULT_PI_AGENT_ID/);
});

test('PI Assistant settings normalizes legacy default runtime instructions', () => {
  assert.match(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS/);
  assert.match(stateSource, /normalizedInstructions\(agent\.instructions\)/);
  assert.match(stateSource, /全局 PI Assistant runtime/);
  assert.match(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS\.has\(value\)/);
});
