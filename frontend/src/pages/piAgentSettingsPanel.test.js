import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const panelStylesSource = readFileSync(new URL('./PiAgentSettingsPanel.css', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
const assistantSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');

test('Xuanwu Supervisor Settings exposes runtime prompt summary debug without secret echo', () => {
  assert.match(panelSource, /当前生效 Prompt 摘要/);
  assert.match(panelSource, /不回显 API key\/token/);
  assert.match(panelSource, /Custom instructions:/);
  assert.match(panelSource, /state\.loadPromptSummary/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(assistantSource, /getPiSupervisorRuntimePrompt:/);
  assert.match(assistantSource, /\/api\/pi\/supervisor\/runtime-prompt/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('Xuanwu Supervisor Settings exposes revisioned presentation-only Chat Persona controls', () => {
  assert.match(panelSource, /Chat 表达风格/);
  assert.match(panelSource, /只对 chat profile 的最终回复生效/);
  assert.match(panelSource, /不改变权限、审批、工具调用、Issue 状态和完成判定/);
  assert.match(panelSource, /personaPersonality/);
  assert.match(panelSource, /personaCommunicationStyle/);
  assert.match(panelSource, /personaVerbosity/);
  assert.match(panelSource, /personaLanguageMode/);
  assert.match(panelSource, /生效 profile：chat/);
  assert.match(stateSource, /expected_revision: form\.personaRevision/);
  assert.match(stateSource, /err\?\.status === 409/);
  assert.match(stateSource, /保留本地草稿供你合并/);
  assert.match(panelSource, /检测到 revision 冲突/);
  assert.match(panelSource, /恢复本地草稿/);
  assert.match(panelSource, /使用服务器版本/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('Xuanwu Supervisor Settings exposes OpenAI Codex OAuth as an optional shortcut', () => {
  assert.match(panelSource, /Codex OAuth/);
  assert.match(panelSource, /复制登录地址/);
  assert.match(panelSource, /state\.oauthStatus\?\.auth_url/);
  assert.match(panelSource, /openai-codex-responses/);
  assert.match(panelSource, /startPiCodexOAuthLogin/);
  assert.match(panelSource, /等待浏览器完成授权；再次登录会生成新的授权地址/);
  assert.match(panelSource, /已连接，重新授权失败/);
  assert.match(panelSource, /status\?\.message/);
  assert.match(stateSource, /copyPiCodexOAuthUrl/);
  assert.doesNotMatch(stateSource, /openOAuthUrl\\(result\\.auth_url\\)/);
  assert.match(panelSource, /OAuth 只替代 API 地址和 Key/);
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
  assert.match(panelSource, /title="Supervisor 模型连接"/);
  assert.match(panelSource, /<ProviderConnectionSettings state=\{state\} \/>/);
  assert.match(panelSource, /API 连接/);
  assert.match(panelSource, /OAuth 快捷登录/);
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
  assert.match(panelSource, /将同时移除 Supervisor OAuth 授权凭据/);
  assert.match(panelSource, /将同时撤销为此连接保存的 API Key/);
  assert.match(panelStylesSource, /\.provider-delete-confirm-button\s*\{[\s\S]*?background:\s*var\(--error\)/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('Supervisor behavior applies the model selected above without duplicating model controls or rewriting credentials', () => {
  assert.match(panelSource, /title="身份与运行偏好"/);
  assert.match(panelSource, /<SupervisorBehaviorSettings state=\{state\} \/>/);
  assert.match(panelSource, /配置玄武使用的模型连接、运行偏好与工具授权/);
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
  assert.match(panelSource, /Xuanwu Supervisor/);
  assert.doesNotMatch(panelSource, /label="Agent ID"/);
  assert.doesNotMatch(panelSource, /Runner Agent Settings/);
  assert.doesNotMatch(stateSource, /assistantApi\.createPiAgent/);
  assert.doesNotMatch(assistantSource, /createPiAgent:/);
  assert.match(stateSource, /assistantApi\.updatePiSupervisor\(payload\)/);
  assert.doesNotMatch(stateSource, /DEFAULT_PI_AGENT_ID|getPiAgents|updatePiAgent/);
});

test('Supervisor settings distinguishes model credentials from Codex and Claude Code login state', () => {
  assert.match(panelSource, /本页只配置 Supervisor 自己使用的模型连接/);
  assert.match(panelSource, /Codex \/ Claude Code 作为执行器时使用本机登录态/);
  assert.match(panelSource, /查看 Code Agents/);
  assert.match(panelSource, /目前 Supervisor 快捷登录支持 Codex \/ ChatGPT/);
  assert.match(panelSource, /Claude Code 的本机登录仍在 Code Agents 中管理/);
  assert.match(panelSource, /Base URL \/ API Path/);
});

test('Supervisor settings relies on migrated canonical data instead of UI compatibility projections', () => {
  assert.doesNotMatch(stateSource, /LEGACY_PI_ASSISTANT_INSTRUCTIONS|LEGACY_PI_AGENT_NAMES/);
  assert.match(stateSource, /normalizedInstructions\(supervisor\.instructions\)/);
  assert.match(stateSource, /Engineering Chief of Staff/);
  assert.match(stateSource, /Work，监督 Run，以 Evidence 判定完成/);
  assert.match(stateSource, /normalizedSupervisorName\(supervisor\.name\)/);
});
