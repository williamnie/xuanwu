import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const panelStylesSource = readFileSync(new URL('./PiAgentSettingsPanel.css', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
const assistantSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');

test('PI Agent Settings exposes runtime prompt summary debug without secret echo', () => {
  assert.match(panelSource, /当前生效 Prompt 摘要/);
  assert.match(panelSource, /不回显 API key\/token/);
  assert.match(panelSource, /Custom instructions:/);
  assert.match(panelSource, /state\.loadPromptSummary/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(assistantSource, /getPiSupervisorRuntimePrompt:/);
  assert.match(assistantSource, /\/api\/pi\/supervisor\/runtime-prompt/);
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

test('Connections provider view uses recommended cards, connection state, and discovered models', () => {
  assert.match(panelSource, /import '\.\/PiAgentSettingsPanel\.css'/);
  assert.match(panelStylesSource, /\.provider-preset-grid/);
  assert.match(panelStylesSource, /\.provider-preset-card\.selected/);
  assert.match(panelStylesSource, /\.provider-recommended-config/);
  assert.match(panelStylesSource, /\.provider-advanced-disclosure/);
  assert.match(panelSource, /view === 'connection'/);
  assert.match(panelSource, /return <ProviderConnectionSettings state=\{state\} \/>/);
  assert.match(panelSource, /ProviderPresetCards/);
  assert.match(panelSource, /provider-connection-chip/);
  assert.match(panelSource, /测试连接并发现模型/);
  assert.match(panelSource, /state\.handleConnectionSave/);
  assert.match(panelSource, /state\.modelOptions\.map/);
  assert.match(panelSource, /自定义 \/ 高级 Provider/);
  assert.match(panelSource, /仅在接入自定义网关、代理或兼容 API 时使用/);
  assert.match(panelSource, /<AdvancedProviderDisclosure state=\{state\} \/>/);
  assert.doesNotMatch(panelSource, /Connections · Custom Provider/);
  assert.match(stateSource, /getPiProviderCatalog/);
  assert.match(stateSource, /testPiProviderConnection/);
  assert.match(stateSource, /getPiProviderModels/);
  assert.match(stateSource, /providerModelOptions/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/catalog/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/\$\{encodeURIComponent\(id\)\}\/test-connection/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/\$\{encodeURIComponent\(id\)\}\/models/);
  assert.match(panelSource, /远端模型列表不可用，已启用手填/);
  assert.match(panelSource, /disabled=\{!state\.modelSelectAvailable/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
  const connectionSaveStart = stateSource.indexOf('async function savePiConnectionSettings');
  const agentSaveStart = stateSource.indexOf('async function savePiSupervisorSettings');
  const connectionSaveSource = stateSource.slice(connectionSaveStart, agentSaveStart);
  assert.match(connectionSaveSource, /updatePiProviderSettings/);
  assert.doesNotMatch(connectionSaveSource, /saveAgent\(/);
});

test('Connections PI Agent registers a newly discovered model without rewriting provider credentials', () => {
  assert.match(panelSource, /view === 'agent'/);
  assert.match(panelSource, /<SupervisorBehaviorSettings state=\{state\} \/>/);
  assert.match(panelSource, /provider 凭据和连接测试统一在 Connections 管理/);
  assert.match(panelSource, /state\.handleAgentSave/);
  assert.match(stateSource, /savePiSupervisorSettings/);
  const agentSaveStart = stateSource.indexOf('async function savePiSupervisorSettings');
  const nextFunction = stateSource.indexOf('async function saveSupervisor', agentSaveStart);
  const agentSaveSource = stateSource.slice(agentSaveStart, nextFunction);
  assert.match(agentSaveSource, /ensureSelectedProviderModel\(form, providers\)/);
  assert.match(agentSaveSource, /saveSupervisor\(supervisorPayload\(form\)\)/);
  assert.match(stateSource, /configured\?\.models\?\.includes\(modelID\)/);
  assert.match(stateSource, /updatePiProviderSettings\(providerID, providerPayload\(form\)\)/);
  assert.match(panelSource, /不会改写凭据/);
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
  assert.match(panelSource, /自定义 \/ 高级 Provider/);
  assert.doesNotMatch(panelSource, /PI Assistant/);
  assert.doesNotMatch(panelSource, /Runner Brain/);
  assert.match(panelSource, /配置唯一 Supervisor/);
  assert.doesNotMatch(panelSource, /label="Agent ID"/);
  assert.doesNotMatch(panelSource, /Runner Agent Settings/);
  assert.doesNotMatch(stateSource, /assistantApi\.createPiAgent/);
  assert.doesNotMatch(assistantSource, /createPiAgent:/);
  assert.match(stateSource, /assistantApi\.updatePiSupervisor\(payload\)/);
  assert.doesNotMatch(stateSource, /DEFAULT_PI_AGENT_ID|getPiAgents|updatePiAgent/);
});

test('Supervisor settings relies on migrated canonical data instead of UI compatibility projections', () => {
  assert.doesNotMatch(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS|LEGACY_PI_AGENT_NAMES/);
  assert.match(stateSource, /normalizedInstructions\(supervisor\.instructions\)/);
  assert.match(stateSource, /Engineering Chief of Staff/);
  assert.match(stateSource, /Work，监督 Run，以 Evidence 判定完成/);
  assert.match(stateSource, /normalizedSupervisorName\(supervisor\.name\)/);
});
