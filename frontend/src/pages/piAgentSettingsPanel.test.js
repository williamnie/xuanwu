import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
const assistantSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');

test('PI Agent Settings exposes runtime prompt summary debug without secret echo', () => {
  assert.match(panelSource, /当前生效 Prompt 摘要/);
  assert.match(panelSource, /不回显 API key\/token/);
  assert.match(panelSource, /Custom instructions:/);
  assert.match(panelSource, /state\.loadPromptSummary/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(assistantSource, /getPiAgentRuntimePrompt:/);
  assert.match(assistantSource, /\/api\/pi\/agents\/\$\{encodeURIComponent\(id\)\}\/runtime-prompt/);
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
  assert.match(assistantSource, /getPiCodexOAuthStatus:/);
  assert.match(assistantSource, /\/api\/pi\/oauth\/openai-codex\/status/);
  assert.match(assistantSource, /\/api\/pi\/oauth\/openai-codex\/login/);
});

test('normal model settings use recommended provider cards, connection state, and discovered models', () => {
  assert.match(panelSource, /if \(!advanced\) return <RecommendedProviderSettings state=\{state\} \/>/);
  assert.match(panelSource, /ProviderPresetCards/);
  assert.match(panelSource, /provider-connection-chip/);
  assert.match(panelSource, /测试连接并发现模型/);
  assert.match(panelSource, /state\.modelOptions\.map/);
  assert.match(panelSource, /Custom advanced/);
  assert.match(panelSource, /Advanced · Model runtime/);
  assert.match(stateSource, /getPiProviderCatalog/);
  assert.match(stateSource, /testPiProviderConnection/);
  assert.match(stateSource, /providerModelOptions/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/catalog/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/\$\{encodeURIComponent\(id\)\}\/test-connection/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('recommended defaults remain stable and API keys stay write-only in local state', () => {
  assert.match(stateSource, /modelId: 'gpt-5\.4'/);
  assert.match(stateSource, /modelProvider: 'openai'/);
  assert.match(stateSource, /apiKey: ''/);
  assert.match(stateSource, /configured\?\.models\?\.\[0\] \|\| preset\.recommended_model/);
  assert.match(panelSource, /type="password"/);
  assert.match(panelSource, /留空保留/);
  assert.doesNotMatch(panelSource, /state\.selectedProvider\.api_key/);
});

test('Supervisor settings no longer expose multi-agent creation controls', () => {
  assert.match(panelSource, /Xuanwu Supervisor · Runtime/);
  assert.doesNotMatch(panelSource, /PI Assistant/);
  assert.doesNotMatch(panelSource, /Runner Brain/);
  assert.match(panelSource, /不会创建多个独立 agent/);
  assert.doesNotMatch(panelSource, /label="Agent ID"/);
  assert.doesNotMatch(panelSource, /Runner Agent Settings/);
  assert.doesNotMatch(stateSource, /assistantApi\.createPiAgent/);
  assert.doesNotMatch(assistantSource, /createPiAgent:/);
  assert.match(stateSource, /assistantApi\.updatePiAgent\(DEFAULT_PI_AGENT_ID/);
});

test('Supervisor settings normalizes legacy default runtime instructions and names', () => {
  assert.match(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS/);
  assert.match(stateSource, /LEGACY_PI_AGENT_NAMES/);
  assert.match(stateSource, /normalizedInstructions\(agent\.instructions\)/);
  assert.match(stateSource, /玄武的 Supervisor runtime/);
  assert.match(stateSource, /Engineering Chief of Staff/);
  assert.match(stateSource, /Work，监督 Run，以 Evidence 判定完成/);
  assert.match(stateSource, /全局 PI Assistant runtime/);
  assert.match(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS\.has\(value\)/);
  assert.match(stateSource, /normalizedAgentName\(agent\.name\)/);
});
