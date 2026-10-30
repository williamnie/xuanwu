import { readStylesheet } from '../../test-support/readStylesheet.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { translate } from '../i18n/translations.js';

const panelSource = [
  './PiAgentSettingsPanel.jsx',
  './PiProviderConnectionSettings.jsx',
  './PiProviderConnectionFlow.jsx',
  './PiProviderConnectionProgress.jsx',
  './PiSupervisorBehaviorSettings.jsx',
  './PiSettingsFields.jsx',
  './PiCodexOAuthPanel.jsx',
  './piProviderConnectionLabels.js',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const panelStylesSource = readStylesheet(new URL('./PiAgentSettingsPanel.css', import.meta.url), 'utf8');
const stateSource = [
  './piAgentSettingsState.js',
  './piAgentSettingsForm.js',
  './piAgentConnectionActions.js',
  './piAgentOAuthActions.js',
  './piAgentSettingsPersistence.js',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const assistantSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');

test('Supervisor settings drop the read-only prompt summary and keep instructions under more options', () => {
  assert.doesNotMatch(panelSource, /当前生效 Prompt 摘要|PromptSummaryDebug|state\.loadPromptSummary/);
  assert.match(panelSource, /<strong>更多选项<\/strong>/);
  assert.match(panelSource, /给玄武的长期说明/);
  assert.match(panelSource, /state\.updateField\('instructions', event\.target\.value\)/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(assistantSource, /getPiSupervisorRuntimePrompt:/);
  assert.match(assistantSource, /\/api\/pi\/supervisor\/runtime-prompt/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('Persona is edited in General by its own panel with its own revisioned save', () => {
  const personaSource = readFileSync(new URL('./PersonaSettingsPanel.jsx', import.meta.url), 'utf8');
  const personaModel = readFileSync(new URL('./personaSettingsModel.js', import.meta.url), 'utf8');
  const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
  assert.match(sections, /<PersonaSettingsPanel \/>/);
  assert.match(personaSource, /对话与通知的表达风格/);
  assert.match(personaSource, /不改变通知是否发送/);
  assert.match(personaSource, /assistantApi\.updatePiSupervisor\(personaPatchPayload\(form\)\)/);
  assert.match(personaModel, /expected_revision: form\.revision/);
  assert.match(personaSource, /saveError\?\.status === 409/);
  assert.match(personaSource, /配置已被更新/);
  assert.match(personaSource, /恢复本地草稿/);
  assert.match(personaSource, /使用最新版本/);
  assert.doesNotMatch(personaSource, /window\.confirm|window\.alert/);
  // 助手面板不再编辑 persona，因此它的保存不会带上 persona、也不会覆盖“通用”里的草稿。
  assert.doesNotMatch(panelSource, /ChatPersonaSettings|personaPersonality/);
  assert.match(stateSource, /form\.personaDirty \? \{ persona:/);
});

test('Xuanwu Supervisor Settings exposes OpenAI Codex OAuth as an optional shortcut', () => {
  assert.match(panelSource, /Codex OAuth/);
  assert.match(panelSource, /复制登录地址/);
  assert.match(panelSource, /state\.oauthStatus\?\.auth_url/);
  assert.match(panelSource, /openai-codex-responses/);
  assert.match(panelSource, /startPiCodexOAuthLogin/);
  assert.match(panelSource, /等待浏览器完成授权；再次登录会生成新的授权地址/);
  assert.match(panelSource, /授权失败，可在“更多”中重新授权/);
  assert.match(panelSource, /status\?\.message/);
  assert.match(stateSource, /copyPiCodexOAuthUrl/);
  assert.doesNotMatch(stateSource, /openOAuthUrl\\(result\\.auth_url\\)/);
  assert.match(panelSource, /description=\{t\('credential.storedHint'\)\}/);
  assert.equal(translate('zh-CN', 'credential.storedHint'), '为玄武助手单独授权，与 Codex 互不影响');
  assert.doesNotMatch(panelSource, /User-Agent|Provider ID/);
  assert.match(stateSource, /getPiCodexOAuthStatus/);
  assert.match(stateSource, /startPiCodexOAuthLogin/);
  assert.match(stateSource, /logoutPiCodexOAuth/);
  assert.match(assistantSource, /getPiCodexOAuthStatus:/);
  assert.match(assistantSource, /\/api\/pi\/oauth\/openai-codex\/status/);
  assert.match(assistantSource, /\/api\/pi\/oauth\/openai-codex\/login/);
});

test('Supervisor page uses one flat API-first connection console with discovered models', () => {
  assert.match(panelSource, /import '\.\/PiAgentSettingsPanel\.css'/);
  assert.match(panelStylesSource, /\.provider-console \{/);
  assert.match(panelStylesSource, /\.provider-mode-tabs/);
  assert.match(panelStylesSource, /border-radius: 0;/);
  assert.doesNotMatch(panelStylesSource, /\.provider-preset-card/);
  assert.match(panelSource, /title="连接助手模型"/);
  assert.match(panelSource, /<ProviderConnectionSettings state=\{state\} \/>/);
  assert.match(panelSource, /API 连接/);
  assert.match(panelSource, /t\('credential.storedLogin'\)/);
  assert.equal(translate('zh-CN', 'credential.storedLogin'), '单独登录 ChatGPT 账号');
  assert.match(panelSource, /API 协议/);
  assert.match(panelSource, /API 地址/);
  assert.match(panelSource, /API Key/);
  assert.match(panelSource, /获取模型/);
  assert.match(panelSource, /测试连接/);
  assert.match(panelSource, /保存并设为默认/);
  assert.match(panelSource, /state\.handleConnectionApply/);
  assert.match(panelSource, /state\.modelOptions\.map/);
  assert.match(panelSource, /手动输入模型 ID/);
  assert.doesNotMatch(panelSource, /AdvancedProviderDisclosure|ProviderPresetCards|自定义 Provider|Provider ID|User-Agent/);
  assert.match(stateSource, /getPiProviderCatalog/);
  assert.match(stateSource, /testPiProviderConnection/);
  assert.match(stateSource, /getPiProviderModels/);
  assert.match(stateSource, /providerModelOptions/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/catalog/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/\$\{encodeURIComponent\(id\)\}\/test-connection/);
  assert.match(assistantSource, /\/api\/pi\/provider-settings\/\$\{encodeURIComponent\(id\)\}\/models/);
  assert.match(panelSource, /远端模型列表不可用，可手动填写模型 ID/);
  assert.match(panelSource, /disabled=\{!state\.modelSelectAvailable/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
  const connectionSaveStart = stateSource.indexOf('async function savePiConnectionAndSupervisor');
  const agentSaveStart = stateSource.indexOf('async function savePiSupervisorSettings');
  const connectionSaveSource = stateSource.slice(connectionSaveStart, agentSaveStart);
  assert.match(connectionSaveSource, /updatePiProviderSettings/);
  assert.match(connectionSaveSource, /saveSupervisor\(supervisorPayload\(form\)\)/);
});

test('saved Supervisor connections can be deleted with in-app confirmation and active-connection protection', () => {
  assert.match(assistantSource, /deletePiProviderSettings:/);
  assert.match(assistantSource, /method: 'DELETE'/);
  assert.match(stateSource, /deletePiProviderConnection/);
  assert.match(stateSource, /assistantApi\.deletePiProviderSettings\(providerId\)/);
  assert.match(panelSource, /className="provider-delete-confirm"/);
  assert.match(panelSource, /role="alertdialog"/);
  assert.match(panelSource, /provider\.in_use \? '默认连接' : '删除连接'/);
  assert.match(panelSource, /将同时移除玄武助手的 OAuth 授权/);
  assert.match(panelSource, /将同时撤销为此连接保存的 API Key/);
  assert.match(panelStylesSource, /\.provider-delete-confirm-button\s*\{[\s\S]*?background:\s*var\(--error\)/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('Supervisor behavior applies the model selected above without duplicating model controls or rewriting credentials', () => {
  assert.match(panelSource, /title="助手偏好"/);
  assert.match(panelSource, /<SupervisorBehaviorSettings state=\{state\} \/>/);
  assert.match(panelSource, /<h3>玄武助手<\/h3>/);
  assert.match(panelSource, /当前默认模型/);
  assert.doesNotMatch(panelSource, /label="Model Provider"|label="Model ID"/);
  assert.match(panelSource, /state\.handleAgentSave/);
  assert.match(stateSource, /savePiSupervisorSettings/);
  const agentSaveStart = stateSource.indexOf('async function savePiSupervisorSettings');
  const nextFunction = stateSource.indexOf('async function saveSupervisor', agentSaveStart);
  const agentSaveSource = stateSource.slice(agentSaveStart, nextFunction);
  assert.match(agentSaveSource, /ensureSelectedProviderModel\(form, providers\)/);
  assert.match(agentSaveSource, /saveSupervisor\(supervisorPayload\(form\)\)/);
  assert.match(stateSource, /configured\?\.models\?\.includes\(modelID\)/);
  assert.match(stateSource, /updatePiProviderSettings\(providerID, providerPayload\(form\)\)/);
  assert.match(panelSource, /不会改写上方连接凭据/);
});

test('recommended defaults remain stable and API keys stay write-only in local state', () => {
  assert.match(stateSource, /modelId: 'gpt-5\.4'/);
  assert.match(stateSource, /modelProvider: 'openai'/);
  assert.match(stateSource, /baseUrl: 'https:\/\/api\.openai\.com\/v1'/);
  assert.match(stateSource, /apiKey: ''/);
  assert.match(stateSource, /configured\?\.models\?\.\[0\] \|\| preset\.recommended_model/);
  assert.match(panelSource, /type=\{visible \? 'text' : 'password'\}/);
  assert.match(panelSource, /留空保留/);
  assert.doesNotMatch(panelSource, /state\.selectedProvider\.api_key/);
});

test('Supervisor settings no longer expose multi-agent or internal provider controls', () => {
  assert.match(panelSource, /连接到一个模型 API/);
  assert.doesNotMatch(panelSource, /Provider ID|User-Agent|高级设置/);
  assert.doesNotMatch(panelSource, /PI Assistant/);
  assert.doesNotMatch(panelSource, /Runner Brain/);
  assert.doesNotMatch(panelSource, /label="Agent ID"/);
  assert.doesNotMatch(panelSource, /Runner Agent Settings/);
  assert.doesNotMatch(stateSource, /assistantApi\.createPiAgent/);
  assert.doesNotMatch(assistantSource, /createPiAgent:/);
  assert.match(stateSource, /assistantApi\.updatePiSupervisor\(payload\)/);
  assert.doesNotMatch(stateSource, /DEFAULT_PI_AGENT_ID|getPiAgents|updatePiAgent/);
});

test('Supervisor settings distinguishes model credentials from Codex and Claude Code login state', () => {
  assert.doesNotMatch(panelSource, /MODEL RUNTIME/);
  assert.match(panelSource, /助手快捷登录目前支持 Codex \/ ChatGPT/);
  assert.match(panelSource, /Claude Code 的本机登录请前往“编程工具”检查/);
  assert.match(panelSource, /Base URL \/ API Path/);
});

test('Supervisor settings relies on migrated canonical data instead of UI compatibility projections', () => {
  assert.doesNotMatch(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS|LEGACY_PI_AGENT_NAMES/);
  assert.match(stateSource, /normalizedInstructions\(supervisor\.instructions\)/);
  assert.match(stateSource, /说人话/);
  assert.doesNotMatch(stateSource, /Engineering Chief of Staff/);
  assert.match(stateSource, /normalizedSupervisorName\(supervisor\.name\)/);
});

test('connection choices reuse radio cards, OAuth secondary actions are disclosed, and status stays separate', () => {
  assert.match(panelSource, /settings-notification-modes provider-mode-tabs/);
  assert.match(panelSource, /className="settings-notification-mode"/);
  assert.match(panelSource, /name="assistant-connection-mode"/);
  assert.match(panelSource, /<details className="settings-disclosure supervisor-oauth-more">/);
  assert.match(panelSource, /'Signed in' : '已登录'/);
  assert.match(panelSource, /'Authorization' : '授权'/);
  assert.match(panelSource, /'Tested and available' : '已测试可用'/);
  assert.match(panelSource, /piConnectionStatus\(state\)/);
  assert.match(stateSource, /if \(key === 'modelId'\) invalidateConnectionTest\(\)/);
  assert.match(panelStylesSource, /@media \(max-width: 760px\)[\s\S]*?\.provider-mode-tabs \{ grid-template-columns: 1fr;/);
  assert.match(panelStylesSource, /\.provider-connection-summary \{[^}]*background: var\(--surface-raised\)/);
});
