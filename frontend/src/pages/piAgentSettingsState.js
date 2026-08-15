import { assistantApi } from '../api/assistant.js';
import { useEffect, useMemo, useState } from 'react';
import { PRODUCT_TERMS } from '../brand';
import { message } from '../store/toastStore';
import { clearFirstDeliveryConnectionTest, recordFirstDeliveryConnectionTest } from '../utils/firstDeliveryConnection.js';

export const DEFAULT_PI_AGENT_FORM = {
  agentName: PRODUCT_TERMS.supervisor,
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  instructions: '你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。',
  modelId: 'gpt-5.4',
  modelProvider: 'openai',
  personaCommunicationStyle: '',
  personaDirty: false,
  personaEnabled: false,
  personaLanguageMode: 'system',
  personaPersonality: '',
  personaRevision: 0,
  personaVerbosity: 'adaptive',
  thinkingLevel: 'medium',
  userAgent: ''
};

const CONNECTION_FIELDS = new Set(['api', 'apiKey', 'baseUrl', 'modelId', 'modelProvider', 'userAgent']);

export function usePiAgentSettingsState() {
  const [connectionTest, setConnectionTest] = useState({ busy: false, providerId: '', result: null });
  const [modelDiscovery, setModelDiscovery] = useState({ busy: false, providerId: '', result: null });
  const [providers, setProviders] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState({ presets: [] });
  const [form, setForm] = useState(DEFAULT_PI_AGENT_FORM);
  const [loading, setLoading] = useState(true);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);
  const [promptSummary, setPromptSummary] = useState(null);
  const [promptSummaryLoading, setPromptSummaryLoading] = useState(false);
  const [personaConflictDraft, setPersonaConflictDraft] = useState(null);
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
    () => providerModelOptions(form, modelDiscovery),
    [form, modelDiscovery]
  );
  const modelSelectAvailable = modelDiscovery.providerId === form.modelProvider && modelDiscovery.result?.ok === true;

  const loadSettings = () => {
    loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary, setModelDiscovery);
    loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  };
  const loadOAuthStatus = () => loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  const loadPromptSummary = () => loadPiPromptSummary(setPromptSummary, setPromptSummaryLoading);
  const updateField = (key, value) => {
    if (key === 'instructions' || key.startsWith('persona')) setPromptSummary(null);
    if (CONNECTION_FIELDS.has(key)) {
      clearFirstDeliveryConnectionTest();
      if (key !== 'modelId') setModelDiscovery({ busy: false, providerId: '', result: null });
    }
    if (key === 'modelProvider') setConnectionTest({ busy: false, providerId: '', result: null });
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key.startsWith('persona') && key !== 'personaRevision' && key !== 'personaDirty' ? { personaDirty: true } : {})
    }));
  };
  const selectProviderPreset = (preset) => {
    clearFirstDeliveryConnectionTest();
    const configured = providers.find((provider) => provider.id === preset.id);
    setConnectionTest({ busy: false, providerId: '', result: null });
    const next = {
      ...form,
      api: configured?.api || preset.api,
      apiKey: '',
      baseUrl: configured?.base_url || preset.base_url,
      modelId: form.modelProvider === preset.id
        ? form.modelId
        : configured?.models?.[0] || preset.recommended_model,
      modelProvider: preset.id
    };
    setForm(next);
  };
  const selectApiProtocol = (api) => {
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId: '', result: null });
    setModelDiscovery({ busy: false, providerId: '', result: null });
    setForm(connectionFormForApi(api, form, providers, providerCatalog.presets));
  };
  const startNewApiConnection = () => {
    const api = form.api === 'openai-codex-responses' ? 'openai-responses' : form.api;
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId: '', result: null });
    setModelDiscovery({ busy: false, providerId: '', result: null });
    setForm((current) => ({
      ...current,
      api,
      apiKey: '',
      baseUrl: defaultBaseURL(api),
      modelId: '',
      modelProvider: availableProviderID(api, providers),
      userAgent: ''
    }));
  };
  const selectApiMode = () => selectApiProtocol(form.api === 'openai-codex-responses' ? 'openai-responses' : form.api);
  const selectOAuthMode = () => {
    const preset = providerCatalog.presets.find((item) => item.auth === 'oauth');
    if (!preset) return message.error('当前版本没有可用的 Supervisor OAuth 登录');
    selectProviderPreset(preset);
  };
  const discoverModels = () => discoverPiModels(form, setModelDiscovery);
  const handleConnectionApply = () => savePiConnectionAndSupervisor({ form, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving });
  const handleAgentSave = () => savePiSupervisorSettings({ form, providers, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving });
  const restorePersonaConflictDraft = () => {
    if (!personaConflictDraft) return;
    setForm((current) => ({ ...current, ...personaConflictDraft, personaDirty: true }));
    setPersonaConflictDraft(null);
  };
  const dismissPersonaConflictDraft = () => setPersonaConflictDraft(null);
  const selectModelProvider = (providerId) => selectConfiguredProvider(providerId, form, providers, providerCatalog.presets, setForm, setConnectionTest, setModelDiscovery);
  const testConnection = () => testPiConnection(form, setConnectionTest, setModelDiscovery);
  const startPiCodexOAuthLogin = () => startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus);
  const copyPiCodexOAuthUrl = () => copyOAuthUrl(oauthStatus?.auth_url);
  const openPiCodexOAuthUrl = () => openOAuthUrl(oauthStatus?.auth_url);
  const logoutPiCodexOAuth = () => logoutPiOAuth(setOauthBusy, setOauthStatus);

  useEffect(() => {
    loadSettings();
  }, []);

  return { connectionTest, form, loading, modelDiscovery, modelOptions, modelSelectAvailable, oauthBusy, oauthStatus, personaConflictDraft, promptSummary, promptSummaryLoading, providerCatalog, providers, saving, selectedPreset, selectedProvider,
    copyPiCodexOAuthUrl, dismissPersonaConflictDraft, discoverModels, handleAgentSave, handleConnectionApply, loadOAuthStatus, loadPromptSummary, loadSettings, logoutPiCodexOAuth, openPiCodexOAuthUrl, restorePersonaConflictDraft, selectApiMode, selectApiProtocol, selectModelProvider, selectOAuthMode, selectProviderPreset, startNewApiConnection, startPiCodexOAuthLogin, testConnection, updateField };
}

function connectionFormForApi(api, form, providers, presets) {
  const currentSaved = providers.some((provider) => provider.id === form.modelProvider);
  const currentUnsaved = form.api !== 'openai-codex-responses' && !currentSaved;
  const providerID = currentUnsaved ? availableProviderID(api, providers) : providerIDForApi(api);
  const configured = currentUnsaved
    ? undefined
    : providers.find((provider) => provider.id === providerID)
      || providers.find((provider) => provider.api === api && provider.id !== 'openai-codex');
  const preset = presets.find((item) => item.auth !== 'oauth' && item.api === api)
    || presets.find((item) => item.id === providerID);
  const nextProviderID = currentUnsaved ? providerID : configured?.id || preset?.id || providerID;
  const sameConnection = form.modelProvider === nextProviderID;
  return {
    ...form,
    api,
    apiKey: '',
    baseUrl: sameConnection
      ? form.baseUrl
      : configured?.base_url || preset?.base_url || defaultBaseURL(api),
    modelId: sameConnection
      ? form.modelId
      : configured?.models?.[0] || preset?.recommended_model || '',
    modelProvider: nextProviderID,
    userAgent: configured?.user_agent || ''
  };
}

function availableProviderID(api, providers) {
  const base = providerIDForApi(api);
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function providerIDForApi(api) {
  if (api === 'anthropic') return 'anthropic';
  if (api === 'google') return 'google';
  return 'openai';
}

function defaultBaseURL(api) {
  if (api === 'anthropic') return 'https://api.anthropic.com/v1';
  if (api === 'google') return 'https://generativelanguage.googleapis.com/v1beta';
  return 'https://api.openai.com/v1';
}

function loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary, setModelDiscovery) {
  setLoading(true);
  Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiProviderSettings(), assistantApi.getPiProviderCatalog()])
    .then(([supervisor, providerSettings, providerCatalog]) => {
      const nextProviders = providerSettings?.providers || [];
      setProviders(nextProviders);
      setProviderCatalog({ presets: providerCatalog?.presets || [] });
      const nextForm = formFromState(supervisor, nextProviders);
      setForm(nextForm);
      setPromptSummary(null);
      void discoverPiModels(nextForm, setModelDiscovery);
    })
    .catch((err) => message.error(err.message || '读取 Supervisor 设置失败'))
    .finally(() => setLoading(false));
}

async function discoverPiModels(form, setModelDiscovery) {
  const providerId = form.modelProvider.trim();
  if (!providerId) return;
  setModelDiscovery({ busy: true, providerId, result: null });
  try {
    const result = await assistantApi.getPiProviderModels(providerId, providerPayload(form));
    setModelDiscovery((current) => current.providerId === providerId ? { busy: false, providerId, result } : current);
  } catch (err) {
    setModelDiscovery((current) => current.providerId === providerId ? {
      busy: false,
      providerId,
      result: { error: 'request_failed', message: err.message || '读取远端模型列表失败', models: [], ok: false, status: 'failed' }
    } : current);
  }
}

async function testPiConnection(form, setConnectionTest, setModelDiscovery) {
  const providerId = form.modelProvider.trim();
  if (!providerId) return message.error('请先选择 provider');
  setConnectionTest({ busy: true, providerId, result: null });
  try {
    const result = await assistantApi.testPiProviderConnection(providerId, providerPayload(form));
    recordFirstDeliveryConnectionTest(result);
    setConnectionTest({ busy: false, providerId, result });
    setModelDiscovery({ busy: false, providerId, result });
    if (result.ok) message.success(result.message || '模型连接成功');
    else message.error(result.message || '模型连接失败');
  } catch (err) {
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId, result: { error: 'request_failed', message: err.message || '模型连接失败', ok: false, status: 'failed' } });
    setModelDiscovery({ busy: false, providerId, result: { error: 'request_failed', message: err.message || '读取远端模型列表失败', models: [], ok: false, status: 'failed' } });
    message.error(err.message || '模型连接失败');
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

async function loadPiPromptSummary(setPromptSummary, setPromptSummaryLoading) {
  setPromptSummaryLoading(true);
  try {
    setPromptSummary(await assistantApi.getPiSupervisorRuntimePrompt());
  } catch (err) {
    message.error(err.message || '读取生效 prompt 摘要失败');
  } finally {
    setPromptSummaryLoading(false);
  }
}

async function savePiConnectionAndSupervisor({ form, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving }) {
  if (!isValidForm(form)) return;
  setSaving(true);
  let connectionSaved = false;
  try {
    const providerID = form.modelProvider.trim();
    await assistantApi.updatePiProviderSettings(providerID, providerPayload(form));
    connectionSaved = true;
    await saveSupervisor(supervisorPayload(form));
    setPersonaConflictDraft(null);
    setPromptSummary(null);
    message.success('模型连接已保存并设为 Supervisor 默认模型');
    await refreshAfterSave(setProviders, setForm);
  } catch (err) {
    if (err?.status === 409) {
      setPersonaConflictDraft(personaDraft(form));
      await refreshAfterSave(setProviders, setForm);
      message.error('连接已保存，但 Chat Persona revision 已变化；已保留本地草稿，请处理冲突后再保存运行偏好');
      return;
    }
    message.error(connectionSaved
      ? '连接参数已保存，但设置 Supervisor 默认模型失败，请重试'
      : err.message || '保存模型连接失败');
  } finally {
    setSaving(false);
  }
}

async function savePiSupervisorSettings({ form, providers, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving }) {
  if (!isValidAgentForm(form)) return;
  setSaving(true);
  try {
    await ensureSelectedProviderModel(form, providers);
    await saveSupervisor(supervisorPayload(form));
    setPersonaConflictDraft(null);
    message.success('Supervisor 行为设置已保存');
    setPromptSummary(null);
    await refreshAfterSave(setProviders, setForm);
  } catch (err) {
    if (err?.status === 409) {
      setPersonaConflictDraft(personaDraft(form));
      await refreshAfterSave(setProviders, setForm);
      message.error('Chat Persona 已被其他修改更新；已重新加载最新 revision，并保留本地草稿供你合并');
      return;
    }
    message.error(err.message || '保存 Supervisor 行为设置失败');
  } finally {
    setSaving(false);
  }
}

function personaDraft(form) {
  return {
    personaCommunicationStyle: form.personaCommunicationStyle,
    personaEnabled: form.personaEnabled,
    personaLanguageMode: form.personaLanguageMode,
    personaPersonality: form.personaPersonality,
    personaVerbosity: form.personaVerbosity
  };
}

async function ensureSelectedProviderModel(form, providers) {
  const providerID = form.modelProvider.trim();
  const modelID = form.modelId.trim();
  const configured = providers.find((provider) => provider.id === providerID);
  if (configured?.models?.includes(modelID)) return;
  await assistantApi.updatePiProviderSettings(providerID, providerPayload(form));
}

async function saveSupervisor(payload) {
  return await assistantApi.updatePiSupervisor(payload);
}

async function refreshAfterSave(setProviders, setForm) {
  const [supervisor, providerSettings] = await Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiProviderSettings()]);
  const nextProviders = providerSettings?.providers || [];
  setProviders(nextProviders);
  setForm({ ...formFromState(supervisor, nextProviders), apiKey: '' });
}

function isValidForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim() && form.api.trim()) return true;
  message.error('API 协议和模型不能为空');
  return false;
}

function isValidAgentForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim()) return true;
  message.error('请先在上方选择默认模型');
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

function supervisorPayload(form) {
  return {
    name: form.agentName.trim() || DEFAULT_PI_AGENT_FORM.agentName,
    model_provider: form.modelProvider.trim(),
    model_id: form.modelId.trim(),
    thinking_level: form.thinkingLevel,
    instructions: form.instructions,
    enabled: form.enabled,
    ...(form.personaDirty ? { persona: {
      expected_revision: form.personaRevision,
      enabled: form.personaEnabled,
      personality: form.personaPersonality,
      communication_style: form.personaCommunicationStyle,
      verbosity: form.personaVerbosity,
      language_mode: form.personaLanguageMode
    } } : {})
  };
}

function formFromState(supervisor, providers) {
  if (!supervisor) return DEFAULT_PI_AGENT_FORM;
  const provider = providers.find((item) => item.id === supervisor.model_provider);
  return {
    ...DEFAULT_PI_AGENT_FORM,
    agentName: normalizedSupervisorName(supervisor.name),
    api: provider?.api || DEFAULT_PI_AGENT_FORM.api,
    apiKey: '',
    baseUrl: provider?.base_url || '',
    enabled: supervisor.enabled === 1,
    instructions: normalizedInstructions(supervisor.instructions),
    modelId: supervisor.model_id || provider?.models?.[0] || DEFAULT_PI_AGENT_FORM.modelId,
    modelProvider: supervisor.model_provider || DEFAULT_PI_AGENT_FORM.modelProvider,
    personaCommunicationStyle: supervisor.persona?.communication_style || '',
    personaDirty: false,
    personaEnabled: supervisor.persona?.enabled === 1,
    personaLanguageMode: supervisor.persona?.language_mode || 'system',
    personaPersonality: supervisor.persona?.personality || '',
    personaRevision: Number.isInteger(supervisor.persona?.revision) ? supervisor.persona.revision : 0,
    personaVerbosity: supervisor.persona?.verbosity || 'adaptive',
    thinkingLevel: supervisor.thinking_level || DEFAULT_PI_AGENT_FORM.thinkingLevel,
    userAgent: provider?.user_agent || ''
  };
}

function selectConfiguredProvider(providerId, form, providers, presets, setForm, setConnectionTest, setModelDiscovery) {
  const configured = providers.find((provider) => provider.id === providerId);
  const preset = presets.find((item) => item.id === providerId);
  const next = {
    ...form,
    api: configured?.api || preset?.api || form.api,
    apiKey: '',
    baseUrl: configured?.base_url || preset?.base_url || '',
    modelId: configured?.models?.[0] || preset?.recommended_model || form.modelId,
    modelProvider: providerId,
    userAgent: configured?.user_agent || '',
  };
  clearFirstDeliveryConnectionTest();
  setConnectionTest({ busy: false, providerId: '', result: null });
  setForm(next);
  void discoverPiModels(next, setModelDiscovery);
}

function providerModelOptions(form, modelDiscovery) {
  const discovered = modelDiscovery.providerId === form.modelProvider && modelDiscovery.result?.ok
    ? modelDiscovery.result.models || []
    : [];
  return [...new Set([form.modelId, ...discovered].filter(Boolean))];
}

function normalizedInstructions(instructions) {
  const value = String(instructions || '').trim();
  if (!value) return DEFAULT_PI_AGENT_FORM.instructions;
  return instructions;
}

function normalizedSupervisorName(name) {
  const value = String(name || '').trim();
  if (!value) return DEFAULT_PI_AGENT_FORM.agentName;
  return name;
}
