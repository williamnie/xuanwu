import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

export const DEFAULT_PI_AGENT_FORM = {
  agentId: 'runner-default',
  agentName: 'Default Runner',
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  instructions: '你是全局 Runner Agent，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
  modelId: 'gpt-5.4',
  modelProvider: 'openai',
  thinkingLevel: 'medium'
};

export function usePiAgentSettingsState() {
  const [agents, setAgents] = useState([]);
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(DEFAULT_PI_AGENT_FORM);
  const [loading, setLoading] = useState(true);
  const [promptSummary, setPromptSummary] = useState(null);
  const [promptSummaryLoading, setPromptSummaryLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === form.modelProvider),
    [form.modelProvider, providers]
  );

  const loadSettings = () => loadPiSettings(setAgents, setProviders, setForm, setLoading, setPromptSummary);
  const loadPromptSummary = () => loadPiPromptSummary(form.agentId, setPromptSummary, setPromptSummaryLoading);
  const updateField = (key, value) => {
    if (key === 'agentId' || key === 'instructions') setPromptSummary(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const handleSave = () => savePiSettings({ agents, form, setAgents, setForm, setPromptSummary, setProviders, setSaving });

  useEffect(() => {
    loadSettings();
  }, []);

  return { form, loading, promptSummary, promptSummaryLoading, providers, saving, selectedProvider,
    handleSave, loadPromptSummary, loadSettings, updateField };
}

function loadPiSettings(setAgents, setProviders, setForm, setLoading, setPromptSummary) {
  setLoading(true);
  Promise.all([api.getPiAgents(), api.getPiProviderSettings()])
    .then(([agentList, providerSettings]) => {
      const nextAgents = agentList || [];
      const nextProviders = providerSettings?.providers || [];
      setAgents(nextAgents);
      setProviders(nextProviders);
      setForm(formFromState(nextAgents, nextProviders));
      setPromptSummary(null);
    })
    .catch((err) => message.error(err.message || '读取 Runner 设置失败'))
    .finally(() => setLoading(false));
}

async function loadPiPromptSummary(agentId, setPromptSummary, setPromptSummaryLoading) {
  const id = agentId.trim();
  if (!id) return message.error('请先保存或选择 Runner Agent');
  setPromptSummaryLoading(true);
  try {
    setPromptSummary(await api.getPiAgentRuntimePrompt(id));
  } catch (err) {
    message.error(err.message || '读取生效 prompt 摘要失败');
  } finally {
    setPromptSummaryLoading(false);
  }
}

async function savePiSettings({ agents, form, setAgents, setForm, setPromptSummary, setProviders, setSaving }) {
  if (!isValidForm(form)) return;
  setSaving(true);
  try {
    await api.updatePiProviderSettings(form.modelProvider.trim(), providerPayload(form));
    await saveAgent(agents, agentPayload(form));
    message.success('Runner Agent 设置已保存');
    setPromptSummary(null);
    await refreshAfterSave(setAgents, setProviders, setForm);
  } catch (err) {
    message.error(err.message || '保存 Runner 设置失败');
  } finally {
    setSaving(false);
  }
}

async function saveAgent(agents, payload) {
  if (agents.some((agent) => agent.id === payload.id)) return await api.updatePiAgent(payload.id, payload);
  return await api.createPiAgent(payload);
}

async function refreshAfterSave(setAgents, setProviders, setForm) {
  const [agentList, providerSettings] = await Promise.all([api.getPiAgents(), api.getPiProviderSettings()]);
  setAgents(agentList || []);
  setProviders(providerSettings?.providers || []);
  setForm((current) => ({ ...current, apiKey: '' }));
}

function isValidForm(form) {
  if (form.agentId.trim() && form.modelProvider.trim() && form.modelId.trim() && form.api.trim()) return true;
  message.error('Agent ID、provider、model、API 类型不能为空');
  return false;
}

function providerPayload(form) {
  return {
    api: form.api.trim(),
    api_key: form.apiKey.trim(),
    base_url: form.baseUrl.trim(),
    models: form.modelId.trim()
  };
}

function agentPayload(form) {
  return {
    id: form.agentId.trim(),
    name: form.agentName.trim() || form.agentId.trim(),
    model_provider: form.modelProvider.trim(),
    model_id: form.modelId.trim(),
    thinking_level: form.thinkingLevel,
    instructions: form.instructions,
    enabled: form.enabled
  };
}

function formFromState(agents, providers) {
  const agent = agents.find((item) => item.enabled === 1) || agents[0];
  if (!agent) return DEFAULT_PI_AGENT_FORM;
  const provider = providers.find((item) => item.id === agent.model_provider);
  return {
    ...DEFAULT_PI_AGENT_FORM,
    agentId: agent.id,
    agentName: agent.name,
    api: provider?.api || DEFAULT_PI_AGENT_FORM.api,
    apiKey: '',
    baseUrl: provider?.base_url || '',
    enabled: agent.enabled === 1,
    instructions: agent.instructions || DEFAULT_PI_AGENT_FORM.instructions,
    modelId: agent.model_id || provider?.models?.[0] || DEFAULT_PI_AGENT_FORM.modelId,
    modelProvider: agent.model_provider || DEFAULT_PI_AGENT_FORM.modelProvider,
    thinkingLevel: agent.thinking_level || DEFAULT_PI_AGENT_FORM.thinkingLevel
  };
}
