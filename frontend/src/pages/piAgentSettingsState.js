import { assistantApi } from '../api/assistant.js';
import { useEffect, useMemo, useState } from 'react';
import { PRODUCT_TERMS } from '../brand';
import { message } from '../store/toastStore';

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

export function usePiAgentSettingsState() {
  const [providers, setProviders] = useState([]);
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

  const loadSettings = () => {
    loadPiSettings(setProviders, setForm, setLoading, setPromptSummary);
    loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  };
  const loadOAuthStatus = () => loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  const loadPromptSummary = () => loadPiPromptSummary(DEFAULT_PI_AGENT_ID, setPromptSummary, setPromptSummaryLoading);
  const updateField = (key, value) => {
    if (key === 'instructions') setPromptSummary(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const handleSave = () => savePiSettings({ form, setForm, setPromptSummary, setProviders, setSaving });
  const startPiCodexOAuthLogin = () => startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus);
  const copyPiCodexOAuthUrl = () => copyOAuthUrl(oauthStatus?.auth_url);
  const openPiCodexOAuthUrl = () => openOAuthUrl(oauthStatus?.auth_url);
  const logoutPiCodexOAuth = () => logoutPiOAuth(setOauthBusy, setOauthStatus);

  useEffect(() => {
    loadSettings();
  }, []);

  return { form, loading, oauthBusy, oauthStatus, promptSummary, promptSummaryLoading, providers, saving, selectedProvider,
    copyPiCodexOAuthUrl, handleSave, loadOAuthStatus, loadPromptSummary, loadSettings, logoutPiCodexOAuth, openPiCodexOAuthUrl, startPiCodexOAuthLogin, updateField };
}

function loadPiSettings(setProviders, setForm, setLoading, setPromptSummary) {
  setLoading(true);
  Promise.all([assistantApi.getPiAgents(), assistantApi.getPiProviderSettings()])
    .then(([agentList, providerSettings]) => {
      const nextAgents = agentList || [];
      const nextProviders = providerSettings?.providers || [];
      setProviders(nextProviders);
      setForm(formFromState(nextAgents, nextProviders));
      setPromptSummary(null);
    })
    .catch((err) => message.error(err.message || '读取 Supervisor 设置失败'))
    .finally(() => setLoading(false));
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

async function savePiSettings({ form, setForm, setPromptSummary, setProviders, setSaving }) {
  if (!isValidForm(form)) return;
  setSaving(true);
  try {
    await assistantApi.updatePiProviderSettings(form.modelProvider.trim(), providerPayload(form));
    await saveAgent(agentPayload(form));
    message.success('Supervisor Settings 已保存');
    setPromptSummary(null);
    await refreshAfterSave(setProviders, setForm);
  } catch (err) {
    message.error(err.message || '保存 Supervisor Settings 失败');
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

function isValidForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim() && form.api.trim()) return true;
  message.error('provider、model、API 类型不能为空');
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
