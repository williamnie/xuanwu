import { assistantApi } from '../api/assistant.js';
import { useEffect, useMemo, useState } from 'react';
import { PRODUCT_TERMS } from '../brand';
import { message } from '../store/toastStore';
import { clearFirstDeliveryConnectionTest, recordFirstDeliveryConnectionTest } from '../utils/firstDeliveryConnection.js';

export const DEFAULT_PI_AGENT_ID = 'runner-default';

export const DEFAULT_PI_AGENT_FORM = {
  agentId: DEFAULT_PI_AGENT_ID,
  agentName: PRODUCT_TERMS.supervisor,
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  instructions: '你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。',
  modelId: 'gpt-5.4',
  modelProvider: 'openai',
  thinkingLevel: 'medium',
  userAgent: ''
};

const LEGACY_PI_ASSISTANT_INSTRUCTIONS = new Set([
  '你是玄武的 Supervisor runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀工程记忆。',
  '你是全局 PI Assistant runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
  '你是全局 Runner Agent，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
  '你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
]);

const LEGACY_PI_AGENT_NAMES = new Set(['PI Assistant', 'Runner Agent', 'Runner Brain']);
const CONNECTION_FIELDS = new Set(['api', 'apiKey', 'baseUrl', 'modelId', 'modelProvider', 'userAgent']);

export function usePiAgentSettingsState() {
  const [connectionTest, setConnectionTest] = useState({ busy: false, providerId: '', result: null });
  const [providers, setProviders] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState({ presets: [] });
  const [form, setForm] = useState(DEFAULT_PI_AGENT_FORM);
  const [loading, setLoading] = useState(true);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);
  const [promptSummary, setPromptSummary] = useState(null);
  const [promptSummaryLoading, setPromptSummaryLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === form.modelProvider),
    [form.modelProvider, providers]
  );
  const selectedPreset = useMemo(
    () => providerCatalog.presets.find((preset) => preset.id === form.modelProvider),
    [form.modelProvider, providerCatalog.presets]
  );
  const modelOptions = useMemo(
    () => providerModelOptions(form, selectedPreset, selectedProvider, connectionTest),
    [connectionTest, form, selectedPreset, selectedProvider]
  );

  const loadSettings = () => {
    loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary);
    loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  };
  const loadOAuthStatus = () => loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  const loadPromptSummary = () => loadPiPromptSummary(DEFAULT_PI_AGENT_ID, setPromptSummary, setPromptSummaryLoading);
  const updateField = (key, value) => {
    if (key === 'instructions') setPromptSummary(null);
    if (CONNECTION_FIELDS.has(key)) clearFirstDeliveryConnectionTest();
    if (key === 'modelProvider') setConnectionTest({ busy: false, providerId: '', result: null });
    setForm((current) => ({ ...current, [key]: value }));
  };
  const selectProviderPreset = (preset) => {
    clearFirstDeliveryConnectionTest();
    const configured = providers.find((provider) => provider.id === preset.id);
    setConnectionTest({ busy: false, providerId: '', result: null });
    setForm((current) => ({
      ...current,
      api: configured?.api || preset.api,
      apiKey: '',
      baseUrl: configured?.base_url || preset.base_url,
      modelId: current.modelProvider === preset.id
        ? current.modelId
        : configured?.models?.[0] || preset.recommended_model,
      modelProvider: preset.id
    }));
  };
  const handleConnectionSave = () => savePiConnectionSettings({ form, setForm, setProviders, setSaving });
  const handleAgentSave = () => savePiAgentSettings({ form, setForm, setPromptSummary, setProviders, setSaving });
  const testConnection = () => testPiConnection(form, setConnectionTest);
  const startPiCodexOAuthLogin = () => startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus);
  const copyPiCodexOAuthUrl = () => copyOAuthUrl(oauthStatus?.auth_url);
  const openPiCodexOAuthUrl = () => openOAuthUrl(oauthStatus?.auth_url);
  const logoutPiCodexOAuth = () => logoutPiOAuth(setOauthBusy, setOauthStatus);

  useEffect(() => {
    loadSettings();
  }, []);

  return { connectionTest, form, loading, modelOptions, oauthBusy, oauthStatus, promptSummary, promptSummaryLoading, providerCatalog, providers, saving, selectedPreset, selectedProvider,
    copyPiCodexOAuthUrl, handleAgentSave, handleConnectionSave, loadOAuthStatus, loadPromptSummary, loadSettings, logoutPiCodexOAuth, openPiCodexOAuthUrl, selectProviderPreset, startPiCodexOAuthLogin, testConnection, updateField };
}

function loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary) {
  setLoading(true);
  Promise.all([assistantApi.getPiAgents(), assistantApi.getPiProviderSettings(), assistantApi.getPiProviderCatalog()])
    .then(([agentList, providerSettings, providerCatalog]) => {
      const nextAgents = agentList || [];
      const nextProviders = providerSettings?.providers || [];
      setProviders(nextProviders);
      setProviderCatalog({ presets: providerCatalog?.presets || [] });
      setForm(formFromState(nextAgents, nextProviders));
      setPromptSummary(null);
    })
    .catch((err) => message.error(err.message || '读取 Supervisor 设置失败'))
    .finally(() => setLoading(false));
}

async function testPiConnection(form, setConnectionTest) {
  const providerId = form.modelProvider.trim();
  if (!providerId) return message.error('请先选择 provider');
  setConnectionTest({ busy: true, providerId, result: null });
  try {
    const result = await assistantApi.testPiProviderConnection(providerId, providerPayload(form));
    recordFirstDeliveryConnectionTest(result);
    setConnectionTest({ busy: false, providerId, result });
    if (result.ok) message.success(result.message || 'Provider 连接成功');
    else message.error(result.message || 'Provider 连接失败');
  } catch (err) {
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId, result: { error: 'request_failed', message: err.message || 'Provider 连接失败', ok: false, status: 'failed' } });
    message.error(err.message || 'Provider 连接失败');
  }
}

async function loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy) {
  setOauthBusy(true);
  try {
    setOauthStatus(await assistantApi.getPiCodexOAuthStatus());
  } catch (err) {
    message.error(err.message || '读取 Codex OAuth 状态失败');
  } finally {
    setOauthBusy(false);
  }
}

async function startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus) {
  setOauthBusy(true);
  try {
    const result = await assistantApi.startPiCodexOAuthLogin();
    setOauthStatus(result);
    applyCodexOAuthPreset(setForm);
    message.success('已生成 Codex OAuth 登录地址，请复制到已登录 ChatGPT 的浏览器打开');
  } catch (err) {
    message.error(err.message || '启动 Codex OAuth 登录失败');
  } finally {
    setOauthBusy(false);
  }
}

async function copyOAuthUrl(url) {
  if (!url) return message.error('当前没有可复制的 OAuth 登录地址');
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return message.error('当前浏览器不支持直接复制，请手动选中登录地址复制');
  }
  try {
    await navigator.clipboard.writeText(url);
    message.success('已复制 OAuth 登录地址');
  } catch (err) {
    message.error(err.message || '复制 OAuth 登录地址失败');
  }
}

function applyCodexOAuthPreset(setForm) {
  setForm((current) => ({
    ...current,
    api: 'openai-codex-responses',
    apiKey: '',
    baseUrl: '',
    modelId: current.modelId || 'gpt-5.4',
    modelProvider: 'openai-codex'
  }));
}

async function logoutPiOAuth(setOauthBusy, setOauthStatus) {
  setOauthBusy(true);
  try {
    setOauthStatus(await assistantApi.logoutPiCodexOAuth());
    message.success('已退出 Supervisor Codex OAuth');
  } catch (err) {
    message.error(err.message || '退出 Supervisor Codex OAuth 失败');
  } finally {
    setOauthBusy(false);
  }
}

function openOAuthUrl(url) {
  if (!url || typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function loadPiPromptSummary(agentId, setPromptSummary, setPromptSummaryLoading) {
  const id = agentId.trim();
  if (!id) return message.error('默认 Supervisor 尚不可用');
  setPromptSummaryLoading(true);
  try {
    setPromptSummary(await assistantApi.getPiAgentRuntimePrompt(id));
  } catch (err) {
    message.error(err.message || '读取生效 prompt 摘要失败');
  } finally {
    setPromptSummaryLoading(false);
  }
}

async function savePiConnectionSettings({ form, setForm, setProviders, setSaving }) {
  if (!isValidForm(form)) return;
  setSaving(true);
  try {
    const providerID = form.modelProvider.trim();
    await assistantApi.updatePiProviderSettings(providerID, providerPayload(form));
    message.success('Provider 连接设置已保存');
    await refreshProviderAfterSave(providerID, setProviders, setForm);
  } catch (err) {
    message.error(err.message || '保存 Provider 连接设置失败');
  } finally {
    setSaving(false);
  }
}

async function savePiAgentSettings({ form, setForm, setPromptSummary, setProviders, setSaving }) {
  if (!isValidAgentForm(form)) return;
  setSaving(true);
  try {
    await saveAgent(agentPayload(form));
    message.success('Supervisor 行为设置已保存');
    setPromptSummary(null);
    await refreshAfterSave(setProviders, setForm);
  } catch (err) {
    message.error(err.message || '保存 Supervisor 行为设置失败');
  } finally {
    setSaving(false);
  }
}

async function saveAgent(payload) {
  return await assistantApi.updatePiAgent(DEFAULT_PI_AGENT_ID, payload);
}

async function refreshAfterSave(setProviders, setForm) {
  const [agentList, providerSettings] = await Promise.all([assistantApi.getPiAgents(), assistantApi.getPiProviderSettings()]);
  const nextAgents = agentList || [];
  const nextProviders = providerSettings?.providers || [];
  setProviders(nextProviders);
  setForm({ ...formFromState(nextAgents, nextProviders), apiKey: '' });
}

async function refreshProviderAfterSave(providerID, setProviders, setForm) {
  const providerSettings = await assistantApi.getPiProviderSettings();
  const nextProviders = providerSettings?.providers || [];
  const provider = nextProviders.find(item => item.id === providerID);
  setProviders(nextProviders);
  setForm(current => ({
    ...current,
    api: provider?.api || current.api,
    apiKey: '',
    baseUrl: provider?.base_url || current.baseUrl,
    modelId: provider?.models?.[0] || current.modelId,
    modelProvider: providerID,
    userAgent: provider?.user_agent || current.userAgent,
  }));
}

function isValidForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim() && form.api.trim()) return true;
  message.error('provider、model、API 类型不能为空');
  return false;
}

function isValidAgentForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim()) return true;
  message.error('provider 和 model 不能为空');
  return false;
}

function providerPayload(form) {
  return {
    api: form.api.trim(),
    api_key: form.apiKey.trim(),
    base_url: form.baseUrl.trim(),
    models: form.modelId.trim(),
    user_agent: form.userAgent.trim()
  };
}

function agentPayload(form) {
  return {
    id: DEFAULT_PI_AGENT_ID,
    name: form.agentName.trim() || DEFAULT_PI_AGENT_FORM.agentName,
    model_provider: form.modelProvider.trim(),
    model_id: form.modelId.trim(),
    thinking_level: form.thinkingLevel,
    instructions: form.instructions,
    enabled: form.enabled
  };
}

function formFromState(agents, providers) {
  const agent = defaultAgentFromList(agents);
  if (!agent) return DEFAULT_PI_AGENT_FORM;
  const provider = providers.find((item) => item.id === agent.model_provider);
  return {
    ...DEFAULT_PI_AGENT_FORM,
    agentId: agent.id,
    agentName: normalizedAgentName(agent.name),
    api: provider?.api || DEFAULT_PI_AGENT_FORM.api,
    apiKey: '',
    baseUrl: provider?.base_url || '',
    enabled: agent.enabled === 1,
    instructions: normalizedInstructions(agent.instructions),
    modelId: agent.model_id || provider?.models?.[0] || DEFAULT_PI_AGENT_FORM.modelId,
    modelProvider: agent.model_provider || DEFAULT_PI_AGENT_FORM.modelProvider,
    thinkingLevel: agent.thinking_level || DEFAULT_PI_AGENT_FORM.thinkingLevel,
    userAgent: provider?.user_agent || ''
  };
}

function providerModelOptions(form, preset, provider, connectionTest) {
  const discovered = connectionTest.providerId === form.modelProvider ? connectionTest.result?.models || [] : [];
  const catalog = preset?.models?.map((model) => model.id) || [];
  return [...new Set([form.modelId, ...(provider?.models || []), ...discovered, ...catalog].filter(Boolean))];
}

function normalizedInstructions(instructions) {
  const value = String(instructions || '').trim();
  if (!value || LEGACY_PI_ASSISTANT_INSTRUCTIONS.has(value)) {
    return DEFAULT_PI_AGENT_FORM.instructions;
  }
  return instructions;
}

function normalizedAgentName(name) {
  const value = String(name || '').trim();
  if (!value || LEGACY_PI_AGENT_NAMES.has(value)) {
    return DEFAULT_PI_AGENT_FORM.agentName;
  }
  return name;
}

function defaultAgentFromList(agents) {
  if (!Array.isArray(agents)) return null;
  return agents.find((item) => item.id === DEFAULT_PI_AGENT_ID)
    || agents.find((item) => item.enabled === 1)
    || agents[0]
    || null;
}
